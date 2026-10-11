const express = require("express");
const {
  getShipments,
  getShipmentStats,
  confirmShipment,
} = require("../controllers/shipmentController");
const { protect } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/adminProtect");

const router = express.Router();

// Admin panel → "Shipment Details": who ordered what, plus the delivery record.
router.use(protect, requireAdmin);

router.get("/stats", getShipmentStats);
// Confirm an order straight from the panel (same handler as the email link).
router.post("/:orderId/confirm", confirmShipment);
router.get("/", getShipments);

module.exports = router;
