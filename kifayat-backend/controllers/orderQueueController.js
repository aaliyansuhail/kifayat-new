const PreOrder = require("../models/PreOrder");
const ShipmentRecord = require("../models/ShipmentRecord");
const { buildItems } = require("./shipmentController");
const { pointsForOrder } = require("./orderController");

// ─────────────────────────────────────────────────────────────────────────────
// The two order queues the admin panel works with:
//
//   UNCONFIRMED  → pre_orders   (placed by the customer, awaiting confirmation)
//   CONFIRMED    → shipment_records
//
// Confirming an order from the panel runs the canonical handler in
// orderController.adminConfirmOrder, which physically moves the document — the
// pre_orders row (plus its Order / ShippingDetail rows) is deleted and the
// shipment_records row is written — and credits the customer's loyalty points
// exactly once. These read endpoints only describe the two queues, so the two
// admin screens always agree with what is actually in MongoDB.
// ─────────────────────────────────────────────────────────────────────────────

const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Normalized customer block shared by both queues. */
function mapUser(doc) {
  const populated = doc?.user && typeof doc.user === "object" ? doc.user : null;
  return {
    _id: populated ? String(populated._id) : doc?.user ? String(doc.user) : "",
    name: String(populated?.name || doc?.name || ""),
    email: String(populated?.email || doc?.email || doc?.userEmail || "").toLowerCase(),
    phone: String(populated?.phone || doc?.phoneNumber || ""),
    loyaltyPoints: Number(populated?.loyaltyPoints ?? 0),
  };
}

/** Ordered lines for a pending pre-order (items carry their own product ref). */
function mapPreOrderItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const populated = item?.product && typeof item.product === "object" ? item.product : null;
      const quantity = Number(item?.quantity) || 0;
      const price = Number(item?.price ?? populated?.salePrice ?? 0) || 0;
      return {
        productObjectId: item?.product ? String(populated?._id || item.product) : "",
        productId: String(item?.productId || populated?.productId || ""),
        name: String(item?.name || populated?.name || ""),
        sku: String(item?.sku || populated?.sku || ""),
        imageUrl: String(item?.imageUrl || populated?.imageUrl || ""),
        variation: String(item?.variation || ""),
        quantity,
        price,
        lineTotal: Math.round(price * quantity),
      };
    })
    .filter((i) => i.name || i.productId || i.quantity > 0);
}

const shortOrderNumber = (id) => `KP-${String(id || "").slice(-8).toUpperCase()}`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/order-queue/unconfirmed  (admin only)
//
// Everything the customer submitted that has NOT been confirmed yet: the user
// account (uid), the full shipment form and every product line ordered.
// Query: ?search= &page= &limit=
// ─────────────────────────────────────────────────────────────────────────────
const getUnconfirmedOrders = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    // A pre-order row only ever exists while the order is unconfirmed —
    // confirming deletes it. Cancelled rows are kept out of the working queue.
    const query = { status: { $nin: ["cancelled"] } };
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [
        { name: rx },
        { email: rx },
        { phoneNumber: rx },
        { phoneNumber2: rx },
        { courierCity: rx },
        { order: rx },
        { confirmationToken: rx },
      ];
    }

    const [docs, total] = await Promise.all([
      PreOrder.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("user", "name email phone loyaltyPoints")
        .populate("items.product", "name sku productId imageUrl salePrice")
        .lean(),
      PreOrder.countDocuments(query),
    ]);

    const orders = docs.map((doc) => {
      const items = mapPreOrderItems(doc.items);
      const orderID = String(doc.order || "");
      const totalAmount = Number(doc.sellPrice ?? doc.totalAmount ?? 0) || 0;
      return {
        _id: String(doc._id),
        preOrderId: String(doc._id),
        orderID,
        orderNumber: shortOrderNumber(orderID || doc._id),
        status: doc.status || "pending",
        createdAt: doc.createdAt || null,
        confirmationExpiresAt: doc.confirmationExpiresAt || null,
        // The uid the data is stored under in MongoDB.
        user: mapUser(doc),
        customer: {
          name: String(doc.name || ""),
          email: String(doc.email || "").toLowerCase(),
          phoneNumber: String(doc.phoneNumber || ""),
          phoneNumber2: String(doc.phoneNumber2 || ""),
        },
        shipment: {
          name: String(doc.name || ""),
          address: String(doc.address || ""),
          shpType: doc.shpType || "Regular",
          courierCompany: String(doc.courierCompany || ""),
          courierCity: String(doc.courierCity || ""),
          phoneNumber: String(doc.phoneNumber || ""),
          phoneNumber2: String(doc.phoneNumber2 || ""),
          courierInstruction: String(doc.courierInstruction || ""),
          shipping: doc.shipping || "cod",
          allowToOpen: String(doc.allowToOpen || ""),
          businessProfiles: doc.businessProfiles ?? 1,
          latitude: doc.latitude ?? null,
          longitude: doc.longitude ?? null,
        },
        items,
        itemCount: items.reduce((n, i) => n + i.quantity, 0),
        totalAmount,
        // What the customer will be credited when this order is confirmed.
        pointsPreview: pointsForOrder(totalAmount),
      };
    });

    return res.status(200).json({
      success: true,
      orders,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("getUnconfirmedOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch unconfirmed orders." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/order-queue/confirmed  (admin only)
//
// The mirror queue: orders already moved into shipment_records, with the same
// user / shipment / product detail plus the loyalty points that were credited.
// Query: ?search= &page= &limit=
// ─────────────────────────────────────────────────────────────────────────────
const getConfirmedOrders = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [
        { name: rx },
        { userEmail: rx },
        { phoneNumber: rx },
        { phoneNumber2: rx },
        { courierCity: rx },
        { orderID: rx },
        { productSearch: rx },
      ];
    }

    const [docs, total] = await Promise.all([
      ShipmentRecord.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("user", "name email phone loyaltyPoints")
        .lean(),
      ShipmentRecord.countDocuments(query),
    ]);

    const orders = docs.map((doc) => {
      const items = buildItems(doc);
      const orderID = String(doc.orderID || "");
      const totalAmount = Number(doc.sellPrice ?? 0) || 0;
      return {
        _id: String(doc._id),
        shipmentRecordId: String(doc._id),
        orderID,
        orderNumber: shortOrderNumber(orderID),
        status: doc.trackingStatus || "confirmed",
        createdAt: doc.createdAt || null,
        confirmedAt: doc.confirmedAt || null,
        user: mapUser(doc),
        customer: {
          name: String(doc.name || ""),
          email: String(doc.userEmail || "").toLowerCase(),
          phoneNumber: String(doc.phoneNumber || ""),
          phoneNumber2: String(doc.phoneNumber2 || ""),
        },
        shipment: {
          name: String(doc.name || ""),
          address: String(doc.address || ""),
          shpType: doc.shpType || "Regular",
          courierCompany: String(doc.courierCompany || ""),
          courierCity: String(doc.courierCity || ""),
          phoneNumber: String(doc.phoneNumber || ""),
          phoneNumber2: String(doc.phoneNumber2 || ""),
          courierInstruction: String(doc.courierInstruction || ""),
          shipping: doc.shipping || "cod",
          allowToOpen: String(doc.allowToOpen || ""),
          businessProfiles: doc.businessProfiles ?? 1,
          latitude: doc.latitude ?? null,
          longitude: doc.longitude ?? null,
        },
        items,
        itemCount: items.reduce((n, i) => n + i.quantity, 0),
        totalAmount,
        pointsAwarded: Number(doc.pointsAwarded || 0),
        // Row migrated from the old supplier/CSV collections with no customer
        // reference — flagged so the panel can label it "legacy" rather than
        // showing a blank customer that looks like broken data.
        legacyUnattributed: doc.legacyUnattributed === true,
        stockAlerts: Array.isArray(doc.stockAlerts) ? doc.stockAlerts : [],
      };
    });

    return res.status(200).json({
      success: true,
      orders,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("getConfirmedOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch confirmed orders." });
  }
};

module.exports = { getUnconfirmedOrders, getConfirmedOrders };
