const ShipmentRecord = require("../models/ShipmentRecord");
const { adminConfirmOrder } = require("./orderController");

const escapeRegex = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rebuild the ordered line items from the numbered shipment fields
 * (productId1/productName1/productPrice1/qty1 … productCount).
 */
function buildItems(record = {}) {
  const items = [];
  const count = Number(record.productCount) || 0;
  for (let i = 1; i <= count; i++) {
    const name = record[`productName${i}`] || "";
    const productId = record[`productId${i}`] || record[`product${i}`] || "";
    const quantity = Number(record[`qty${i}`]) || 0;
    const price = Number(record[`productPrice${i}`]) || 0;
    if (!name && !productId && !quantity) continue;
    items.push({
      productId: String(productId || ""),
      name,
      sku: record[`productSku${i}`] || "",
      variation: record[`variationName${i}`] || "",
      quantity,
      price,
      lineTotal: Math.round((price || 0) * (quantity || 0)),
    });
  }
  return items;
}

/**
 * GET /api/admin/shipments  (admin only)
 *
 * The admin "Shipment Details" section: who ordered what, with the full
 * delivery record (recipient, address, city, courier, COD amount, phone).
 *
 * Query: ?search= &city= &page= &limit=
 */
const getShipments = async (req, res) => {
  try {
    const { search = "", city = "", page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    if (search) {
      const rx = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [
        { name: rx },
        { phoneNumber: rx },
        { phoneNumber2: rx },
        { orderID: rx },
        { userEmail: rx },
        { courierCity: rx },
        { productSearch: rx },
      ];
    }
    if (city) {
      query.courierCity = { $regex: escapeRegex(city), $options: "i" };
    }

    const [records, total] = await Promise.all([
      ShipmentRecord.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      ShipmentRecord.countDocuments(query),
    ]);

    const shipments = records.map((r) => {
      return {
        _id: r._id,
        orderID: r.orderID,
        orderNumber: `KP-${String(r.orderID || "").slice(-8).toUpperCase()}`,
        // Fulfilment status lives on the shipment record itself.
        status: r.trackingStatus || "confirmed",
        createdAt: r.createdAt,
        // ── who ──────────────────────────────────────────────────────────
        customerName: r.name || "",
        email: r.userEmail || "",
        phoneNumber: r.phoneNumber || "",
        phoneNumber2: r.phoneNumber2 || "",
        // ── where ────────────────────────────────────────────────────────
        address: r.address || "",
        courierCity: r.courierCity || "",
        courierCompany: r.courierCompany || "",
        shpType: r.shpType || "Regular",
        shipping: r.shipping || "cod",
        courierInstruction: r.courierInstruction || "",
        allowToOpen: r.allowToOpen || "",
        // ── what ─────────────────────────────────────────────────────────
        items: buildItems(r),
        productCount: r.productCount || 0,
        sellPrice: r.sellPrice || 0,
        businessProfiles: r.businessProfiles ?? 1,
        stockAlerts: Array.isArray(r.stockAlerts) ? r.stockAlerts : [],
        // A row migrated in from the old supplier/CSV collections has no
        // customer reference at all. It is flagged so the panel can label it
        // "legacy" instead of showing a blank customer name that reads as a bug.
        legacyUnattributed: r.legacyUnattributed === true,
      };
    });

    return res.status(200).json({
      success: true,
      shipments,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("getShipments error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch shipments." });
  }
};

/**
 * GET /api/admin/shipments/stats  (admin only)
 * Small summary for the admin dashboard: total shipments, COD value, cities.
 */
const getShipmentStats = async (req, res) => {
  try {
    const [total, codAgg, cities] = await Promise.all([
      ShipmentRecord.countDocuments({}),
      ShipmentRecord.aggregate([
        { $group: { _id: null, codTotal: { $sum: "$sellPrice" } } },
      ]),
      ShipmentRecord.distinct("courierCity"),
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        total,
        codTotal: codAgg[0]?.codTotal || 0,
        cities: (cities || []).filter(Boolean).slice(0, 50),
      },
    });
  } catch (err) {
    console.error("getShipmentStats error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch shipment stats." });
  }
};

/**
 * POST /api/admin/shipments/:orderId/confirm  (admin only)
 *
 * The WhatsApp confirmation flow: the admin messages the customer from the
 * Shipment Details screen and confirms the order straight from there. The
 * heavy lifting (stock gate, customer emails, queue move, loyalty points) lives
 * in orderController.adminConfirmOrder so the panel and the emailed link can
 * never drift apart.
 */
const confirmShipment = (req, res) => adminConfirmOrder(req, res);

module.exports = {
  getShipments,
  getShipmentStats,
  confirmShipment,
  buildItems,
};
