const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { trackInteraction } = require("../controllers/interactionController");
const optionalAuth = require("../middleware/optionalAuth");
const requireSameOrigin = require("../middleware/originGuard");

const router = express.Router();

// Tracking is fired on every hover/click, so it gets its own budget — high
// enough for a shopper scrolling a grid, low enough to stop a script.
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, message: "Too many tracking events." },
});

router.post("/track", trackingLimiter, requireSameOrigin, optionalAuth, trackInteraction);

module.exports = router;
