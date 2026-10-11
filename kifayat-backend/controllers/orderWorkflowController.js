const mongoose = require("mongoose");
const PreOrder = require("../models/PreOrder");
const Product = require("../models/Product");
const ShipmentRecord = require("../models/ShipmentRecord");
const Order = require("../models/Order");
const ShippingDetail = require("../models/ShippingDetail");
const CancelOrder = require("../models/CancelOrder");
const CompensationVoucher = require("../models/CompensationVoucher");
const { logActivity, ACTIONS } = require("../utils/activityLogger");
const { escapeRegex } = require("../utils/safeRegex");
const {
  sendLateConfirmationEmail,
  sendStockExhaustionEmail,
  sendOrderCancelledByUserEmail,
  sendInsufficientStockEmail,
  sendCompensationEmail,
  sendAdminStockAlertEmail,
} = require("../utils/email");
const { generateCompensationVouchers } = require("../utils/compensation");
const { restoreOrderVoucherUses } = require("../utils/voucherLifecycle");
const User = require("../models/User");

function normalizeOrderItems(items = []) {
  return items.map((item) => ({
    product: item.product?._id || item.product,
    name: item.name || item.product?.name || "",
    price: item.price ?? item.product?.salePrice ?? 0,
    quantity: item.quantity || 0,
    imageUrl: item.imageUrl || item.product?.imageUrl || "",
  }));
}

/**
 * Rebuild an items array from the numbered ShipmentRecord fields
 * (product1..N / productSku1..N / productName1..N / qty1..N / productPrice1..N).
 *
 * The PreOrder is deleted once an order moves to main_orders, so every
 * admin action on a main order (stock-exhaustion, low-stock removal, system
 * cancel, low-stock listing) must read items from the main-order record —
 * never from a dangling PreOrder lookup.
 */
function mainOrderItems(mainOrder = {}) {
  const items = [];
  const count = Number(mainOrder.productCount) || 0;
  for (let i = 1; i <= count; i++) {
    const sku = mainOrder[`productSku${i}`] || "";
    const rawPid = mainOrder[`product${i}`] || "";
    const price = mainOrder[`productPrice${i}`];
    items.push({
      product: sku || rawPid || "",
      name: mainOrder[`productName${i}`] || "",
      quantity: Number(mainOrder[`qty${i}`]) || 0,
      price: price !== undefined && price !== null ? Number(price) : 0,
      imageUrl: "",
      sku,
    });
  }
  return items;
}

/**
 * Resolve the customer of a main order without a PreOrder: prefer the stored
 * user ref, fall back to the stored email. Used by compensation/archive logic.
 */
async function resolveMainOrderUser(mainOrder = {}) {
  const { user, userEmail } = mainOrder;
  if (user && mongoose.isValidObjectId(user)) {
    const u = await User.findById(user).select("_id email name").lean();
    if (u) return u;
  }
  const email = String(userEmail || mainOrder.email || "").trim().toLowerCase();
  if (email) {
    const u = await User.findOne({ email }).select("_id email name").lean();
    if (u) return u;
  }
  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/workflow/confirm-preorder/:token  — and /api/orders/confirm/:token
// Customer confirms a pre-order through the emailed link:
//   stock available on the website  -> order moves to main_orders
//   otherwise                       -> late_confirmation_orders + admin email
// Both public routes resolve to the SAME canonical handler in orderController
// so the emailed link and this endpoint can never drift.
// ─────────────────────────────────────────────────────────────────────────────
const { confirmOrder } = require("./orderController");
const confirmPreOrderWithThreshold = confirmOrder;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/workflow/cancel-preorder/:token  (public)
// Customer cancels a pre-order from the emailed link.
// ─────────────────────────────────────────────────────────────────────────────
const cancelPreOrderByUser = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 10) {
      return res.status(400).json({ success: false, message: "Invalid cancellation token." });
    }

    const preOrder = await PreOrder.findOne({ confirmationToken: token });
    if (!preOrder) {
      return res.status(404).json({ success: false, message: "Cancellation link is invalid or expired." });
    }

    if (preOrder.status === "confirmed") {
      return res.status(400).json({ success: false, message: "Order already confirmed and cannot be cancelled." });
    }

    // Restore stock
    for (const item of preOrder.items) {
      await Product.findByIdAndUpdate(item.product?._id || item.product, {
        $inc: { stock: item.quantity, salesCount: -item.quantity },
      }).catch(() => {});
    }

    // Move to cancel_orders
    await CancelOrder.create({
      user: preOrder.user,
      order: preOrder.order,
      originalPreOrderId: preOrder._id,
      items: normalizeOrderItems(preOrder.items),
      totalAmount: preOrder.totalAmount,
      name: preOrder.name,
      address: preOrder.address,
      shpType: preOrder.shpType,
      courierCompany: preOrder.courierCompany,
      courierCity: preOrder.courierCity,
      phoneNumber: preOrder.phoneNumber,
      phoneNumber2: preOrder.phoneNumber2,
      sellPrice: preOrder.sellPrice,
      businessProfiles: preOrder.businessProfiles,
      courierInstruction: preOrder.courierInstruction,
      email: preOrder.email,
      shipping: preOrder.shipping,
      allowToOpen: preOrder.allowToOpen,
      cancelledAt: new Date(),
      cancelReason: "Order cancelled by user.",
      cancelReasonCategory: "user_cancelled",
    });

    // Send user cancellation email
    try {
      await sendOrderCancelledByUserEmail(preOrder.email, preOrder.name, preOrder);
    } catch (emailErr) {
      console.error("[Workflow] Failed to send cancellation email:", emailErr);
    }

    // Remove original records
    await Order.deleteOne({ _id: preOrder.order }).catch(() => {});
    await ShippingDetail.deleteOne({ order: preOrder.order }).catch(() => {});
    await PreOrder.deleteOne({ _id: preOrder._id }).catch(() => {});

    // Restore any voucher uses consumed by this order
    await restoreOrderVoucherUses(preOrder.order);

    console.log(`[Workflow] Pre-order ${preOrder._id} cancelled by user — moved to cancel_orders.`);

    return res.status(200).json({
      success: true,
      message: "Order cancelled successfully. Stock has been restored.",
    });
  } catch (err) {
    console.error("[Workflow] cancelPreOrderByUser error:", err);
    return res.status(500).json({ success: false, message: "Failed to cancel order." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/workflow/cancel-system/:orderId
// Admin — system-initiated cancellation with reason type and optional compensation
// ─────────────────────────────────────────────────────────────────────────────
const adminCancelOrderSystem = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.isValidObjectId(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID." });
    }

    const mainOrder = await ShipmentRecord.findOne({ orderID: orderId });
    if (!mainOrder) {
      return res.status(404).json({ success: false, message: "Order not found in main_orders." });
    }


    const { reasonType = "warehouse_revenue", generateCompensation = false, customNote = "", vouchers: adminVouchers } = req.body;

    if (!["insufficient_stock", "warehouse_revenue"].includes(reasonType)) {
      return res.status(400).json({ success: false, message: "Invalid reasonType. Must be 'insufficient_stock' or 'warehouse_revenue'." });
    }

    // Use a transaction for atomicity
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      await ShipmentRecord.deleteOne({ orderID: orderId }).session(session);

      // The PreOrder is already gone for main orders; resolve the customer
      // from the main-order record itself.
      const user = await resolveMainOrderUser(mainOrder);
      const items = mainOrderItems(mainOrder);

      const cancelReasonText = customNote || (reasonType === "insufficient_stock" ? "Insufficient amount/stock" : "Warehouse/Revenue error");

      const [cancelOrder] = await CancelOrder.create([{
        user: user?._id || null,
        order: orderId,
        originalPreOrderId: null,
        items,
        totalAmount: mainOrder.sellPrice || mainOrder.totalAmount || 0,
        name: mainOrder.name,
        address: mainOrder.address,
        shpType: mainOrder.shpType,
        courierCompany: mainOrder.courierCompany,
        courierCity: mainOrder.courierCity,
        phoneNumber: mainOrder.phoneNumber,
        phoneNumber2: mainOrder.phoneNumber2,
        sellPrice: mainOrder.sellPrice,
        businessProfiles: mainOrder.businessProfiles,
        courierInstruction: mainOrder.courierInstruction,
        email: mainOrder.email,
        shipping: mainOrder.shipping,
        allowToOpen: mainOrder.allowToOpen,
        cancelledAt: new Date(),
        cancelReason: cancelReasonText,
        cancelReasonCategory: reasonType,
      }], { session });

      let compensationVouchers = [];
      if (generateCompensation && user) {
        compensationVouchers = await generateCompensationVouchers({
          user: user._id,
          cancelOrder: cancelOrder._id,
          adminSpec: adminVouchers ? { vouchers: adminVouchers } : null,
        });
      }

      await session.commitTransaction();
      session.endSession();

      // Restore any voucher uses consumed by this order
      await restoreOrderVoucherUses(orderId);

      // Send emails (outside transaction)
      if (generateCompensation && compensationVouchers.length > 0) {
        try {
          await sendCompensationEmail(mainOrder.email || "", mainOrder.name, { _id: orderId }, compensationVouchers);
        } catch (emailErr) {
          console.error("[Workflow] Failed to send compensation email:", emailErr);
        }
      } else if (reasonType === "insufficient_stock") {
        try {
          await sendInsufficientStockEmail(mainOrder.email || "", mainOrder.name, { _id: orderId });
        } catch (emailErr) {
          console.error("[Workflow] Failed to send insufficient stock email:", emailErr);
        }
      } else {
        try {
          await sendStockExhaustionEmail(mainOrder.email || "", mainOrder.name, { _id: orderId });
        } catch (emailErr) {
          console.error("[Workflow] Failed to send stock exhaustion email:", emailErr);
        }
      }

      await logActivity({
        user: req.user,
        action: ACTIONS.ORDER_STATUS_CHANGED,
        description: `Order #${orderId.slice(-8).toUpperCase()} — system cancelled (${reasonType})${generateCompensation ? ` + ${compensationVouchers.length} compensation voucher(s)` : ""}.`,
        req,
        metadata: { orderId, reason: reasonType, compensationCount: compensationVouchers.length },
      });

      console.log(`[Workflow] Order ${orderId} — system cancelled (${reasonType})${generateCompensation ? ` with ${compensationVouchers.length} compensation voucher(s)` : ""}.`);

      return res.status(200).json({
        success: true,
        message: `Order cancelled.${generateCompensation && compensationVouchers.length ? ` ${compensationVouchers.length} compensation voucher(s) generated.` : ""}`,
        compensationVouchers: compensationVouchers.length ? compensationVouchers.map(v => ({ _id: v._id, voucher_type: v.voucher_type, discount_percent: v.discount_percent })) : undefined,
        cancelOrderId: cancelOrder._id,
      });
    } catch (txErr) {
      await session.abortTransaction();
      session.endSession();
      throw txErr;
    }
  } catch (err) {
    console.error("[Workflow] adminCancelOrderSystem error:", err);
    return res.status(500).json({ success: false, message: "Failed to cancel order." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/workflow/cancel-orders/filter
// Admin — filtered list of cancelled orders
// ─────────────────────────────────────────────────────────────────────────────
const getCancelOrdersFiltered = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.reason) {
      filter.cancelReasonCategory = req.query.reason;
    }
    if (req.query.user) {
      if (mongoose.isValidObjectId(req.query.user)) {
        filter.user = req.query.user;
      } else {
        filter.$or = [
          { name: { $regex: escapeRegex(req.query.user), $options: "i" } },
          { email: { $regex: escapeRegex(req.query.user), $options: "i" } },
        ];
      }
    }
    if (req.query.dateFrom || req.query.dateTo) {
      filter.cancelledAt = {};
      if (req.query.dateFrom) filter.cancelledAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        filter.cancelledAt.$lte = end;
      }
    }

    const [orders, total] = await Promise.all([
      CancelOrder.find(filter)
        .sort({ cancelledAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .lean(),
      CancelOrder.countDocuments(filter),
    ]);

    // Get compensation counts for each cancelled order
    const cancelOrderIds = orders.map(o => o._id);
    const compCounts = await CompensationVoucher.aggregate([
      { $match: { cancelOrder: { $in: cancelOrderIds } } },
      { $group: { _id: "$cancelOrder", count: { $sum: 1 } } },
    ]);
    const compMap = {};
    compCounts.forEach(c => { compMap[c._id.toString()] = c.count; });

    const ordersWithComp = orders.map(o => ({
      ...o,
      compensationCount: compMap[o._id.toString()] || 0,
    }));

    return res.status(200).json({
      success: true,
      orders: ordersWithComp,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("[Workflow] getCancelOrdersFiltered error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch cancel orders." });
  }
};

// GET /api/workflow/cancel-orders  (admin) — legacy unfiltered
// ─────────────────────────────────────────────────────────────────────────────
const getCancelOrders = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      CancelOrder.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .lean(),
      CancelOrder.countDocuments({}),
    ]);

    return res.status(200).json({
      success: true,
      orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("[Workflow] getCancelOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch cancel orders." });
  }
};

module.exports = {
  confirmPreOrderWithThreshold,
  cancelPreOrderByUser,
  getCancelOrders,
  adminCancelOrderSystem,
  getCancelOrdersFiltered,
  // Shared with utils/mainOrderCancellation.js
  resolveMainOrderUser,
  mainOrderItems,
};
