const express = require("express");
const {
  confirmPreOrderWithThreshold,
  cancelPreOrderByUser,
  getCancelOrders,
  adminCancelOrderSystem,
  getCancelOrdersFiltered,
} = require("../controllers/orderWorkflowController");
const { protect } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/adminProtect");
const requireSameOrigin = require("../middleware/originGuard");

const router = express.Router();

// Public — confirm pre-order with stock threshold check
router.get("/confirm-preorder/:token", confirmPreOrderWithThreshold);

// Public — cancel pre-order by user
router.get("/cancel-preorder/:token", cancelPreOrderByUser);

// Admin — filtered list of cancelled orders (reason / user / date range)
router.get("/cancel-orders/filter", protect, requireAdmin, getCancelOrdersFiltered);

// Admin — list cancel orders
router.get("/cancel-orders", protect, requireAdmin, getCancelOrders);

// Admin — system-initiated cancellation (reason type + optional compensation)
router.post("/cancel-system/:orderId", protect, requireAdmin, requireSameOrigin, adminCancelOrderSystem);

module.exports = router;
