const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const {
  getProducts,
  getSuggestions,
  getTrendingSearches,
  getAdminProducts,
  getLeaderboard,
  getReport,
  getStats,
  clearProducts,
  createManualProduct,
  getProductById,
  getSimilarProducts,
  updateStock,
  updateProduct,
  deleteProduct,
  getDeletedProducts,
  restoreProduct,
  getOutOfStockProducts,
  getCategories,
  updateCategoryImage,
  getAllReports,
  getProductOrders,
  recategorizeAll,
  recategorizeAllKeywords,
  getRecategorizeStatus,
  getFeaturedLanding,
  toggleFeaturedLanding,
  getFeaturedCount,
  setFeaturedOrder,
  updateProductManualPosition,
  updateBulkManualPositions,
  clearAllManualPositions,
} = require("../controllers/productController");
const { uploadProductMedia } = require("../controllers/productMediaController");
const { protect } = require("../middleware/auth");
const { requireAdmin } = require("../middleware/adminProtect");
const requireSameOrigin = require("../middleware/originGuard");

const router = express.Router();

// ── Public storefront routes (must come before /:id to avoid param capture) ──
router.get("/", getProducts);
router.get("/suggest", getSuggestions);
router.get("/trending-searches", getTrendingSearches);

// ── Admin media uploads (product images + video) ─────────────────────────────
const mediaTmpDir = path.join(__dirname, "..", "uploads", "product-media");
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      require("fs").mkdir(mediaTmpDir, { recursive: true }, (err) => cb(err, mediaTmpDir));
    },
    filename: (_req, _file, cb) => cb(null, `tmp-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 10 },
});

const withMulterErrors = (handler) => (req, res, next) =>
  handler(req, res, (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ success: false, message: "Each file must be 40 MB or smaller." });
    }
    if (err && err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ success: false, message: "You can upload at most 10 files at a time." });
    }
    if (err && err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        success: false,
        message: `Unexpected field "${err.field}" — files must be sent as "files".`,
      });
    }
    next(err);
  });

router.post(
  "/upload-media",
  protect,
  requireAdmin,
  requireSameOrigin,
  mediaUpload.array("files", 10),
  withMulterErrors(uploadProductMedia),
);

// ── Product CRUD (admin) ──
router.get("/admin-list", protect, requireAdmin, getAdminProducts);
router.get("/stats", protect, requireAdmin, getStats);
router.get("/leaderboard", protect, requireAdmin, getLeaderboard);
router.get("/out-of-stock", protect, requireAdmin, getOutOfStockProducts);
router.get("/categories", getCategories);
router.get("/featured-landing", getFeaturedLanding);
router.get("/featured-count", protect, requireAdmin, getFeaturedCount);
router.post("/manual", protect, requireAdmin, requireSameOrigin, createManualProduct);
router.delete("/", protect, requireAdmin, requireSameOrigin, clearProducts);
router.post("/recategorize-all", protect, requireAdmin, requireSameOrigin, recategorizeAll);
router.post("/recategorize-all-keywords", protect, requireAdmin, requireSameOrigin, recategorizeAllKeywords);
router.get("/recategorize-status", protect, requireAdmin, getRecategorizeStatus);
router.put("/featured-order", protect, requireAdmin, requireSameOrigin, setFeaturedOrder);
router.put("/manual-positions/bulk", protect, requireAdmin, requireSameOrigin, updateBulkManualPositions);
router.delete("/manual-positions", protect, requireAdmin, requireSameOrigin, clearAllManualPositions);
router.get("/deleted", protect, requireAdmin, getDeletedProducts);
router.patch("/:id/restore", protect, requireAdmin, requireSameOrigin, restoreProduct);
router.put("/categories/update-image", protect, requireAdmin, requireSameOrigin, updateCategoryImage);

// ── Single product (admin) ──
router.get("/:id", getProductById);
router.put("/:id", protect, requireAdmin, requireSameOrigin, updateProduct);
router.delete("/:id", protect, requireAdmin, requireSameOrigin, deleteProduct);
router.patch("/:id/stock", protect, requireAdmin, requireSameOrigin, updateStock);
router.put("/:id/featured-landing", protect, requireAdmin, requireSameOrigin, toggleFeaturedLanding);
router.patch("/:id/manual-position", protect, requireAdmin, requireSameOrigin, updateProductManualPosition);
router.get("/:id/similar", getSimilarProducts);
router.get("/:id/orders", protect, requireAdmin, getProductOrders);

module.exports = router;
