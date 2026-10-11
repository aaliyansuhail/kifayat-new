const express = require("express");
const {
  getUnconfirmedOrders,
  getConfirmedOrders,
} = require("../controllers/orderQueueController");
const { protect } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/adminProtect");

const router = express.Router();

// Admin panel → "Unconfirmed Orders" / "Confirmed Orders".
// Mounted under /api/admin, so the same-origin guard is already applied.
router.use(protect, requireAdmin);

// Orders placed but not confirmed yet (pre_orders) — full user + shipment +
// product detail, ready to be confirmed.
router.get("/unconfirmed", getUnconfirmedOrders);
// Orders already confirmed (shipment_records) — the same detail plus the
// loyalty points credited at confirmation time.
router.get("/confirmed", getConfirmedOrders);

module.exports = router;
