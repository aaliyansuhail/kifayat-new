const fs = require("fs");
const path = require("path");

// ─────────────────────────────────────────────────────────────────────────────
// Magic-byte file type sniffing.
//
// multer's fileFilter trusts the client-supplied mimetype, which is trivial to
// spoof. A browser executes a response by its *served Content-Type* (derived
// from the file extension), not by the mimetype the uploader claimed — so an
// attacker could upload e.g. evil.html with mimetype "video/mp4" and, because
// the old filenames reused the client extension, get a stored-XSS payload
// served as text/html from /uploads/defective/.
//
// Every uploaded file is therefore re-validated from its real bytes here, and
// the on-disk extension is derived from the sniffed format, never from
// file.originalname. Unknown/binary-polyglot inputs are rejected (null).
// ─────────────────────────────────────────────────────────────────────────────

const HEAD_BYTES = 16;

// Returns { type, ext } for an image/video buffer, or null when unrecognised.
// Buffer must be >= HEAD_BYTES long (callers truncate to the head).
const sniffImageOrVideo = (buf) => {
  if (!buf || buf.length < HEAD_BYTES) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: "image/jpeg", ext: "jpg" };
  }

  // PNG signature
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { type: "image/png", ext: "png" };
  }

  // GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { type: "image/gif", ext: "gif" };
  }

  // WebP: "RIFF" .... "WEBP"
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return { type: "image/webp", ext: "webp" };
  }

  // MP4 / MOV / M4V: ISO BMFF "ftyp" box
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12);
    if (brand === "qt  ") return { type: "video/quicktime", ext: "mov" };
    return { type: "video/mp4", ext: "mp4" };
  }

  // WebM / other Matroska: EBML magic 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { type: "video/webm", ext: "webm" };
  }

  // AVI: "RIFF" .... "AVI "
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "AVI ") {
    return { type: "video/x-msvideo", ext: "avi" };
  }

  return null;
};

const readHead = (filePath) => {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
};

// Sniffs a multer file (disk or memory storage). Returns the sniffed
// { type, ext } — matching the allowlist — or null when rejected.
const sniffUpload = ({ path: filePath, buffer }, allowlist) => {
  const head = filePath ? readHead(filePath) : buffer;
  if (!head || head.length === 0) return null;

  if (allowlist === "video") {
    const sniffed = sniffImageOrVideo(head);
    if (!sniffed) return null;
    return sniffed.type.startsWith("video/") ? sniffed : null;
  }
  // default: image (jpeg/png/webp/gif) or full image+video pass-through
  const sniffed = sniffImageOrVideo(head);
  if (!sniffed) return null;
  return sniffed;
};

module.exports = { sniffUpload, sniffImageOrVideo, readHead };