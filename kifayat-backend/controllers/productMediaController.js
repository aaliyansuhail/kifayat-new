const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sniffUpload } = require("../utils/fileSniffer");

// Admin product media (gallery images + the product video) lives on local disk
// and is served by the static /uploads mount, exactly like seller media.
const uploadsDir = path.join(__dirname, "..", "uploads", "product-media");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const MAX_FILES = 10;

/**
 * POST /api/products/upload-media (multipart, field "files")  — admin only
 *
 * Every file is re-validated from its magic bytes (utils/fileSniffer) and the
 * on-disk extension is derived from the sniffed type — never from the client
 * filename — so a spoofed mimetype can't turn into a served HTML payload.
 */
const uploadProductMedia = async (req, res) => {
  try {
    const incoming = Array.isArray(req.files) ? req.files : req.files?.files;
    const files = Array.isArray(incoming) ? incoming : incoming ? [incoming] : [];

    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Choose at least one image or video to upload.",
      });
    }
    if (files.length > MAX_FILES) {
      return res.status(400).json({
        success: false,
        message: `You can upload at most ${MAX_FILES} files at a time.`,
      });
    }

    const uploaded = [];
    const rejected = [];

    for (const file of files) {
      const sniffed = sniffUpload({ path: file.path });
      if (!sniffed) {
        rejected.push({
          name: file.originalname,
          reason: "Unsupported file type. Use JPEG, PNG, WebP, GIF, MP4, WebM or MOV.",
        });
        fs.promises.unlink(file.path).catch(() => {});
        continue;
      }

      const isVideo = sniffed.type.startsWith("video/");
      const filename = `${crypto.randomUUID()}.${sniffed.ext}`;
      const target = path.join(uploadsDir, filename);

      try {
        await fs.promises.rename(file.path, target);
      } catch {
        // rename fails across devices — fall back to copy + unlink.
        await fs.promises.copyFile(file.path, target);
        await fs.promises.unlink(file.path).catch(() => {});
      }

      uploaded.push({
        url: `/uploads/product-media/${filename}`,
        type: isVideo ? "video" : "image",
        mimeType: sniffed.type,
        name: file.originalname,
        size: file.size,
      });
    }

    if (uploaded.length === 0) {
      return res.status(400).json({
        success: false,
        message: rejected[0]?.reason || "None of the uploaded files could be read.",
        rejected,
      });
    }

    return res.status(201).json({
      success: true,
      files: uploaded,
      ...(rejected.length ? { rejected } : {}),
    });
  } catch (err) {
    console.error("Product media upload error:", err);
    return res.status(500).json({
      success: false,
      message: "Upload failed. Please try again.",
    });
  }
};

module.exports = { uploadProductMedia };
