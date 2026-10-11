const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Shipment record — one document per confirmed order that is ready to ship.
//
// This used to be the "Main Order CSV" queue that was exported to the HHC
// supplier. The CSV export, HHC assignment fields and the whole supplier
// workflow are gone; what remains is the shipping queue the admin panel reads
// to see WHO ordered WHAT and with WHICH shipment details.
//
// Confirmed orders live in the clean `shipment_records` collection. Rows left
// in the two legacy collections ("mainordercsvdatas" from the old model's
// default pluralisation, and "MainOrderCSVData") are migrated in by
// scripts/migrate_shipment_records.js.
// ─────────────────────────────────────────────────────────────────────────────

const shipmentRecordSchema = new mongoose.Schema(
  {
    // The Mongo _id of the customer Order this record was created for.
    orderID: { type: String, required: true },
    name: { type: String, required: true },
    address: { type: String, required: true },
    shpType: { type: String, required: true },
    courierCompany: { type: String, required: true },
    courierCity: { type: String, required: true },
    phoneNumber: { type: String, required: true },
    phoneNumber2: { type: String, default: "" },
    sellPrice: { type: Number, required: true },
    businessProfiles: { type: Number, default: 1 },
    courierInstruction: { type: String, default: "" },
    productCount: { type: Number, default: 0 },
    productSearch: { type: [String], default: [] },
    shipping: { type: String, required: true },
    allowToOpen: { type: String, default: "" },
    confirmationToken: { type: String, default: "" },
    // Loyalty points already granted for this order. Non-zero means the award
    // ran, so a repeated confirmation can never double-credit the customer.
    pointsAwarded: { type: Number, default: 0 },
    confirmedAt: { type: Date, default: null },
    // Fulfilment tracking — set by the admin from the "Order Status" panel and
    // surfaced to the customer on "Your Orders". This is now the single source
    // of truth for an order's status (the OrderHistory archive is gone).
    trackingStatus: {
      type: String,
      enum: ["pending", "confirmed", "shipped", "delivered", "cancelled"],
      default: "confirmed",
    },
    trackingStatusUpdatedAt: { type: Date, default: null },
    // Customer reference — lets the admin view resolve who placed the order.
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    userEmail: { type: String, default: "", trim: true, lowercase: true },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    // Customer-facing stock alerts — set when an item in this order went out
    // of stock (deleted from the catalog). The order itself is unaffected.
    stockAlerts: {
      type: [
        {
          productId: { type: String, default: "" },
          productName: { type: String, default: "" },
          sku: { type: String, default: "" },
          notifiedAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    collection: "shipment_records",
    // Product lines are stored as numbered fields (product1..productN,
    // productName1..productNameN, productPrice1..productPriceN, qty1..qtyN),
    // so the schema must stay open.
    strict: false,
  },
);

shipmentRecordSchema.index({ orderID: 1 }, { unique: true });
shipmentRecordSchema.index({ createdAt: -1 });
shipmentRecordSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("ShipmentRecord", shipmentRecordSchema);
