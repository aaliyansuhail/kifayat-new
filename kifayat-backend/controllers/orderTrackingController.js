const mongoose = require("mongoose");
const ShipmentRecord = require("../models/ShipmentRecord");
const CancelOrder = require("../models/CancelOrder");
const { logActivity, ACTIONS } = require("../utils/activityLogger");
const { restoreOrderVoucherUses, burnConsumedVoucherUses } = require("../utils/voucherLifecycle");
const { sendOrderCancelledByUserEmail } = require("../utils/email");

const VALID_STATUSES = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

// Rebuild the ordered line items from the numbered shipment columns
// (productName1/productSku1/variationName1/productPrice1/qty1 … productCount).
function shipmentProducts(doc) {
  const items = [];
  const count = Math.max(0, Number(doc.productCount) || 0);
  for (let i = 1; i <= count; i++) {
    items.push({
      name: String(doc[`productName${i}`] ?? ""),
      sku: String(doc[`productSku${i}`] ?? ""),
      variationName: String(doc[`variationName${i}`] ?? ""),
      price: Number(doc[`productPrice${i}`] ?? 0),
      quantity: Number(doc[`qty${i}`] ?? 1),
      imageUrl: "",
    });
  }
  return items.filter((p) => p.name || p.sku);
}

// Confirmed orders live in the ShipmentRecord collection — the single source of
// truth for an order's fulfilment status now that the OrderHistory archive is
// gone.
function mapShipment(doc) {
  const populatedUser = doc.user && typeof doc.user === "object" ? doc.user : null;
  const userId = populatedUser ? String(populatedUser._id ?? "") : doc.user ? String(doc.user) : "";
  const email = String((populatedUser && populatedUser.email) || doc.userEmail || "")
    .trim()
    .toLowerCase();
  return {
    id: String(doc._id),
    orderID: String(doc.orderID ?? ""),
    sourceOrderID: String(doc.orderID ?? ""),
    status: doc.trackingStatus || "confirmed",
    statusUpdatedAt: doc.trackingStatusUpdatedAt || null,
    name: String(doc.name ?? ""),
    city: String(doc.courierCity ?? ""),
    address: String(doc.address ?? ""),
    phone: String(doc.phoneNumber ?? ""),
    sellPrice: Number(doc.sellPrice ?? 0),
    exportedAt: doc.createdAt || null,
    products: shipmentProducts(doc),
    stockAlerts: Array.isArray(doc.stockAlerts) ? doc.stockAlerts : [],
    user:
      userId || email
        ? {
            userId,
            name: String((populatedUser && populatedUser.name) || doc.name || ""),
            email,
          }
        : null,
    source: "queue",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/order-status  (admin)
// Lists confirmed orders (the shipment queue) with their fulfilment status.
// Pending confirmations and pre-orders never appear here.
// ─────────────────────────────────────────────────────────────────────────────
const getMainOrderStatusList = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const [docs, total] = await Promise.all([
      ShipmentRecord.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .lean(),
      ShipmentRecord.countDocuments({}),
    ]);

    return res.status(200).json({
      success: true,
      orders: docs.map(mapShipment),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getMainOrderStatusList error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch tracked orders." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/order-status/:id  (admin)
// Updates the fulfilment status of a confirmed order and pushes a realtime
// `order_status_updated` event so the owning customer's open session shows a
// toast immediately.
// ─────────────────────────────────────────────────────────────────────────────
const updateTrackingStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }

    const doc = await ShipmentRecord.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: "Tracked order not found." });
    }

    const oldStatus = doc.trackingStatus || "confirmed";
    doc.trackingStatus = status;
    doc.trackingStatusUpdatedAt = new Date();
    await doc.save();

    // Voucher use lifecycle on terminal tracking states:
    //  - cancelled  -> consumed uses are given back to the user
    //  - delivered  -> consumed uses are burned (the order is complete)
    if (status === "cancelled") {
      await restoreOrderVoucherUses(doc.orderID || doc._id);
    } else if (status === "delivered") {
      await burnConsumedVoucherUses(doc.orderID || doc._id);
    }

    // Realtime broadcast — targeted to the user's personal room + admin room
    const io = req.app?.get("io");
    const userId = doc.user ? String(doc.user) : null;
    if (io) {
      const payload = {
        orderID: String(doc.orderID ?? ""),
        sourceOrderID: String(doc.orderID ?? ""),
        status,
        oldStatus,
        updatedAt: doc.trackingStatusUpdatedAt.toISOString(),
      };
      if (userId) io.to(`user-${userId}`).emit("order_status_updated", payload);
      io.to("admin").emit("order_status_updated", { ...payload, userId });
    }

    await logActivity({
      user: req.user,
      action: ACTIONS.ORDER_STATUS_CHANGED,
      description: `Changed main order ${doc.orderID || doc._id} status from "${oldStatus}" to "${status}"`,
      req,
      metadata: { orderId: String(doc._id), oldStatus, newStatus: status },
    });

    return res.status(200).json({ success: true, message: "Order status updated.", order: mapShipment(doc.toObject ? doc.toObject() : doc) });
  } catch (err) {
    console.error("updateTrackingStatus error:", err);
    return res.status(500).json({ success: false, message: "Failed to update status." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders/tracked  (authenticated user)
// The customer's confirmed orders and their fulfilment status.
// ─────────────────────────────────────────────────────────────────────────────
const getMyTrackedOrders = async (req, res) => {
  try {
    const userId = String(req.user._id);
    const email = String(req.user.email || "").trim().toLowerCase();
    const userIdObj = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : null;

    const or = [
      ...(userIdObj ? [{ user: userIdObj }] : []),
      ...(email ? [{ userEmail: email }] : []),
    ];
    if (or.length === 0) {
      return res.status(200).json({ success: true, orders: [] });
    }

    const queue = await ShipmentRecord.find({ $or: or }).sort({ createdAt: -1 }).lean();
    const orders = queue.map(mapShipment);

    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error("getMyTrackedOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch tracked orders." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/tracked/:id/cancel  (authenticated user)
// User-initiated cancellation of a confirmed order. Only allowed for
// pending/confirmed orders that haven't shipped yet.
// ─────────────────────────────────────────────────────────────────────────────
const cancelMyOrder = async (req, res) => {
  try {
    const userId = String(req.user._id);
    const email = String(req.user.email || "").trim().toLowerCase();
    const { reason } = req.body || {};
    const id = req.params.id;

    const doc = await ShipmentRecord.findById(id);
    if (!doc) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    // Ownership check
    const userIdObj = mongoose.isValidObjectId(userId) ? new mongoose.Types.ObjectId(userId) : null;
    const orderUserId = doc.user ? String(doc.user) : "";
    const isOwner =
      (orderUserId && orderUserId === userId) ||
      (userIdObj && orderUserId === String(userIdObj)) ||
      String(doc.userEmail || "").trim().toLowerCase() === email;
    if (!isOwner) {
      return res.status(403).json({ success: false, message: "This order does not belong to you." });
    }

    // Only pending/confirmed can be cancelled
    const currentStatus = doc.trackingStatus || "confirmed";
    if (["shipped", "delivered", "cancelled"].includes(currentStatus)) {
      return res.status(400).json({
        success: false,
        message:
          currentStatus === "cancelled"
            ? "Order is already cancelled."
            : `Order has been ${currentStatus} and cannot be cancelled.`,
      });
    }

    // Archive to CancelOrder and remove from the shipment queue.
    const cancelData = {
      user: doc.user || undefined,
      order: undefined,
      items: [],
      totalAmount: doc.sellPrice || 0,
      name: doc.name || "",
      address: doc.address || "",
      shpType: doc.shpType || "Regular",
      courierCompany: doc.courierCompany || "",
      courierCity: doc.courierCity || "",
      phoneNumber: doc.phoneNumber || "",
      phoneNumber2: doc.phoneNumber2 || "",
      sellPrice: doc.sellPrice || 0,
      businessProfiles: doc.businessProfiles || 1,
      courierInstruction: doc.courierInstruction || "",
      email: doc.userEmail || "",
      shipping: doc.shipping || "cod",
      allowToOpen: doc.allowToOpen || "",
      cancelledAt: new Date(),
      cancelReason: reason || "Cancelled by user.",
      cancelReasonCategory: "user_cancelled",
    };

    // Normalize items from numbered columns
    const count = Math.max(0, Number(doc.productCount) || 0);
    for (let i = 1; i <= count; i++) {
      const name = String(doc[`productName${i}`] || "");
      if (!name) continue;
      cancelData.items.push({
        name,
        price: Number(doc[`productPrice${i}`] || 0),
        quantity: Number(doc[`qty${i}`] || 1),
        imageUrl: String(doc[`productImageUrl${i}`] || ""),
      });
    }

    await CancelOrder.create(cancelData);
    await ShipmentRecord.deleteOne({ _id: doc._id });
    await restoreOrderVoucherUses(doc.orderID || doc._id);

    // Socket event — notify user + admin (targeted rooms)
    const io = req.app?.get("io");
    if (io) {
      const cancelPayload = {
        orderID: String(doc.orderID || ""),
        totalAmount: doc.sellPrice || 0,
        cancelledBy: "user",
      };
      io.to(`user-${userId}`).emit("order_cancelled", cancelPayload);
      io.to("admin").emit("order_cancelled", { ...cancelPayload, userId });
      io.to(`user-${userId}`).emit("order_status_updated", {
        orderID: String(doc.orderID || ""),
        sourceOrderID: String(doc.orderID || ""),
        status: "cancelled",
        oldStatus: currentStatus,
        updatedAt: new Date().toISOString(),
      });
    }

    // Send cancellation email
    try {
      const orderName = doc.name || req.user.name || "";
      await sendOrderCancelledByUserEmail(email, orderName, { orderID: doc.orderID, sellPrice: doc.sellPrice });
    } catch (emailErr) {
      console.error("[Cancel] Failed to send cancellation email:", emailErr);
    }

    // Log activity
    await logActivity({
      user: req.user,
      action: ACTIONS.ORDER_STATUS_CHANGED,
      description: `User cancelled order ${doc.orderID || doc._id}`,
      req,
      metadata: { orderId: String(doc._id), source: "queue", reason: reason || "" },
    });

    return res.json({ success: true, message: "Order cancelled successfully." });
  } catch (err) {
    console.error("cancelMyOrder error:", err);
    return res.status(500).json({ success: false, message: "Failed to cancel order." });
  }
};

module.exports = {
  getMainOrderStatusList,
  updateTrackingStatus,
  getMyTrackedOrders,
  cancelMyOrder,
};
