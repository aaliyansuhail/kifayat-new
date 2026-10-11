const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const {
  getSellerProducts,
  createSellerProduct,
  updateSellerProduct,
  deleteSellerProduct,
  getSellerAnalytics,
} = require("../controllers/sellerController");
const { uploadSellerMedia } = require("../controllers/sellerMediaController");
const { getInteractionAnalytics } = require("../controllers/interactionController");
const { protect } = require("../middleware/auth");
const { requireSeller } = require("../middleware/sellerProtect");
const requireSameOrigin = require("../middleware/originGuard");

const router = express.Router();

// All seller routes require authentication and seller role
router.use(protect);
router.use(requireSeller);

// Media uploads stream to disk (never buffered in memory) and are re-validated
// from magic bytes in the controller — the filename here is a throwaway temp
// name that gets replaced once the real type is known.
const mediaTmpDir = path.join(__dirname, "..", "uploads", "seller-media");
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      require("fs").mkdir(mediaTmpDir, { recursive: true }, (err) => cb(err, mediaTmpDir));
    },
    filename: (_req, _file, cb) => cb(null, `tmp-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 10 },
});

// multer rejects oversize/too-many files mid-stream and throws instead of
// calling next() with a clean status — translate it into the same JSON shape.
const withMulterErrors = (handler) => (req, res, next) =>
  handler(req, res, (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        success: false,
        message: "Each file must be 40 MB or smaller.",
      });
    }
    if (err && err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({
        success: false,
        message: "You can upload at most 10 files at a time.",
      });
    }
    if (err && err.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        success: false,
        message: `Unexpected field "${err.field}" — files must be sent as "files".`,
      });
    }
    next(err);
  });

// Gallery image / video uploads
router.post(
  "/upload-media",
  requireSameOrigin,
  mediaUpload.array("files", 10),
  withMulterErrors(uploadSellerMedia),
);

// Seller analytics
router.get("/analytics", getSellerAnalytics);
// Click / hover / view analytics for the seller's products
router.get("/analytics/interactions", getInteractionAnalytics);

// Seller product CRUD
router.get("/products", getSellerProducts);
router.post("/products", requireSameOrigin, createSellerProduct);
router.put("/products/:id", requireSameOrigin, updateSellerProduct);
router.delete("/products/:id", requireSameOrigin, deleteSellerProduct);

module.exports = router;
