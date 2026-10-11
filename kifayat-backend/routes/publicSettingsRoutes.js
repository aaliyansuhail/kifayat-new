const express = require("express");
const router = express.Router();
const Settings = require("../models/Settings");
const { resolveHeroObjectsForStorefront } = require("../utils/heroObjects");

// ─── GET /api/settings/public — unauthenticated storefront read ──────────────
// Exposes storefront-facing settings (flat delivery fee). Defaults apply when
// the settings doc is missing or the field is unset — nothing is created here.
router.get("/public", async (req, res) => {
  try {
    const s = await Settings.findOne({}).lean();
    const deliveryFee = Number.isFinite(Number(s?.deliveryFee)) ? Number(s.deliveryFee) : 100;
    // Resolve the stored hero ids against the live catalogue: a product deleted
    // or hidden since the admin picked it is returned as null, so the landing
    // page falls back to its curated selection instead of requesting a 404.
    const heroObjects = await resolveHeroObjectsForStorefront(s?.heroObjects);
    res.json({
      success: true,
      deliveryFee,
      heroObjects,
    });
  } catch (err) {
    console.error("publicSettings error:", err);
    res.status(500).json({ success: false, message: "Failed to load settings." });
  }
});

module.exports = router;
