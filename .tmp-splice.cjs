const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "kifayat-backend", "controllers", "productController.js");
let s = fs.readFileSync(file, "utf8");

const isBanner = (l) => /^\/\/\s*─+\s*$/.test(l.trimEnd());

function startOfBannerBefore(markerIdx) {
  const lines = s.slice(0, markerIdx).split("\n");
  let i = lines.length - 1;
  if (lines[i].trim() === "") i -= 1;
  while (i >= 0 && isBanner(lines[i])) i -= 1;
  let first = i + 1;
  while (first - 1 >= 0 && isBanner(lines[first - 1])) first -= 1;
  return lines.slice(0, first).join("\n").length + (first > 0 ? 1 : 0);
}

const cut = (startMarker, endMarker, repl) => {
  const a = s.indexOf(startMarker);
  if (a < 0) throw new Error("start not found: " + startMarker.slice(0, 50));
  const b = s.indexOf(endMarker, a + 1);
  if (b < 0) throw new Error("end not found: " + endMarker.slice(0, 50));
  const start = startOfBannerBefore(a);
  s = s.slice(0, start) + repl + s.slice(b);
};

const BANNER = "// ─────────────────────────────────────────────────────────────────────────────\n";

// ── 1. createManualProduct ───────────────────────────────────────────────────
const newCreate = `${BANNER}// POST /api/products/manual  (admin only)
// Creates one catalogue product from the admin "Add Product" form.
//
// Required: name, description, cost price, sale price, stock, at least
// ${"3"} images and at least 1 video. Products get a sequential public id:
// kp-00000000001, kp-00000000002, …
// ─────────────────────────────────────────────────────────────────────────────
const MIN_PRODUCT_IMAGES = 3;

function normalizeUrlList(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\\n,]/)
      : [];
  return list.map((u) => String(u || "").trim()).filter(Boolean);
}

// Build the ordered product media list: images first, then the video.
function buildGallery(product) {
  const gallery = Array.isArray(product?.gallery) ? product.gallery.filter(Boolean) : [];
  if (gallery.length > 0) return gallery;
  const images = Array.isArray(product?.images) ? product.images.filter(Boolean) : [];
  const items = images.map((url, i) => ({ id: \`image-\${i + 1}\`, url, type: "image" }));
  if (product?.video) items.push({ id: "video-1", url: product.video, type: "video" });
  else if (product?.videoUrl) items.push({ id: "video-1", url: product.videoUrl, type: "video" });
  return items;
}

// Atomically reserve the next public product id (kp-00000000001, …).
async function nextProductId() {
  const settings = await Settings.findOneAndUpdate(
    {},
    { $inc: { productSequence: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  const seq = Number(settings?.productSequence) || 1;
  return \`kp-\${String(seq).padStart(11, "0")}\`;
}

const createManualProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const costPrice = Number(body.costPrice);
    const salePrice = Number(body.salePrice);
    const stockNum =
      body.stock === undefined || body.stock === null || body.stock === ""
        ? 0
        : Number(body.stock);
    const weightNum =
      body.weight === undefined || body.weight === null || body.weight === ""
        ? 0
        : Number(body.weight);
    const images = normalizeUrlList(body.images);
    const video = typeof body.video === "string" ? body.video.trim() : "";
    const cat =
      typeof body.category === "string" && body.category.trim()
        ? body.category.trim()
        : "Uncategorized";

    // ── Validate input ──────────────────────────────────────────────────────
    if (!name) {
      return res.status(400).json({ success: false, message: "Product name is required." });
    }
    if (!description) {
      return res.status(400).json({ success: false, message: "Product description is required." });
    }
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      return res
        .status(400)
        .json({ success: false, message: "Cost price must be a number greater than or equal to 0." });
    }
    if (!Number.isFinite(salePrice) || salePrice <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Sale price must be a number greater than 0." });
    }
    if (!Number.isFinite(stockNum) || stockNum < 0) {
      return res.status(400).json({ success: false, message: "Stock must be a number greater than or equal to 0." });
    }
    if (!Number.isFinite(weightNum) || weightNum < 0) {
      return res.status(400).json({ success: false, message: "Weight must be a number greater than or equal to 0." });
    }
    if (images.length < MIN_PRODUCT_IMAGES) {
      return res
        .status(400)
        .json({ success: false, message: \`At least \${MIN_PRODUCT_IMAGES} product images are required.\` });
    }
    if (!video) {
      return res.status(400).json({ success: false, message: "A product video is required." });
    }

    // ── Category + identity ─────────────────────────────────────────────────
    await Category.findOrCreateCategory(cat);
    const productId = await nextProductId();
    const slug = await uniqueSlug(slugify(name));

    const gallery = [
      ...images.map((url, i) => ({ id: \`image-\${i + 1}\`, url, type: "image" })),
      { id: "video-1", url: video, type: "video" },
    ];

    const doc = await Product.create({
      productId,
      name,
      slug,
      description,
      costPrice,
      salePrice,
      stock: stockNum,
      originalStock: stockNum,
      weight: weightNum,
      images,
      video,
      imageUrl: images[0],
      videoUrl: video,
      gallery,
      category: cat,
      featuredOnLanding: body.featuredOnLanding === true,
      hidden: false,
      salesCount: 0,
      stockOutAt: null,
      sku: typeof body.sku === "string" ? body.sku.trim() : "",
      keywords: generateKeywords(name, cat),
    });

    const io = req.app.get("io");
    if (io) {
      io.emit("products_updated", {
        source: "manual-create",
        created: 1,
        updated: 0,
        productId: doc._id.toString(),
      });
    }

    return res.status(201).json({
      success: true,
      message: \`Product \${productId} created and published.\`,
      product: doc.toPublicObject(),
    });
  } catch (err) {
    console.error("createManualProduct error:", err);
    return res.status(500).json({ success: false, message: "Server error while creating product." });
  }
};

`;

cut("// POST /api/products/manual", "// GET /api/products  (all authenticated users)", newCreate);

// ── 2. getProductById ────────────────────────────────────────────────────────
const newGetById = `${BANNER}// GET /api/products/:id  (single product detail)
// Resolves the public id (kp-00000000001), the slug, or the Mongo _id.
// ─────────────────────────────────────────────────────────────────────────────
const getProductById = async (req, res) => {
  try {
    const key = String(req.params.id || "").trim();
    if (!key) {
      return res.status(400).json({ success: false, message: "Product id is required." });
    }

    let product = null;
    if (mongoose.Types.ObjectId.isValid(key)) {
      product = await Product.findById(key);
    }
    if (!product) {
      product = await Product.findOne({ productId: key });
    }
    if (!product) {
      product = await Product.findOne({ slug: key });
    }

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    const merged = product.toObject ? product.toObject() : { ...product };
    // Ordered media for the product page gallery/lightbox.
    merged.gallery = buildGallery(merged);

    return res.status(200).json({ success: true, product: toCustomerProduct(merged) });
  } catch (err) {
    console.error("getProductById error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch product." });
  }
};

`;

cut("// GET /api/products/:id  (single product detail)", "// GET /api/products/:id/similar", newGetById);

// ── 3. updateProduct ─────────────────────────────────────────────────────────
const newUpdate = `${BANNER}// PUT /api/products/:id  (admin only)
// Updates one product. costPrice stays private; every customer-facing price
// and discount is derived from salePrice.
// ─────────────────────────────────────────────────────────────────────────────
const updateProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const allowed = [
      "name", "description", "costPrice", "salePrice", "stock",
      "images", "video", "imageUrl", "videoUrl", "gallery",
      "weight", "sku", "productId", "category",
      "hidden", "keywords", "seoTitle", "seoDescription", "featuredOnLanding",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Media validation: at least 3 images and exactly one video when provided.
    if (updates.images !== undefined) {
      const images = normalizeUrlList(updates.images);
      if (images.length < MIN_PRODUCT_IMAGES) {
        return res
          .status(400)
          .json({ success: false, message: \`At least \${MIN_PRODUCT_IMAGES} product images are required.\` });
      }
      updates.images = images;
      if (req.body.imageUrl === undefined) updates.imageUrl = images[0];
      if (req.body.gallery === undefined) {
        updates.gallery = [
          ...images.map((url, i) => ({ id: \`image-\${i + 1}\`, url, type: "image" })),
          ...(updates.video || req.body.video
            ? [{ id: "video-1", url: updates.video || req.body.video, type: "video" }]
            : []),
        ];
      }
    }
    if (updates.video !== undefined) {
      const video = String(updates.video || "").trim();
      if (!video) {
        return res.status(400).json({ success: false, message: "A product video is required." });
      }
      updates.video = video;
      if (req.body.videoUrl === undefined) updates.videoUrl = video;
    }

    if (updates.salePrice !== undefined) {
      const sale = Number(updates.salePrice);
      if (!Number.isFinite(sale) || sale <= 0) {
        return res.status(400).json({ success: false, message: "Sale price must be a number greater than 0." });
      }
      updates.salePrice = sale;
    }
    if (updates.costPrice !== undefined) {
      const cost = Number(updates.costPrice);
      if (!Number.isFinite(cost) || cost < 0) {
        return res.status(400).json({ success: false, message: "Cost price must be a number greater than or equal to 0." });
      }
      updates.costPrice = cost;
    }

    // Regenerate slug when name changes
    if (updates.name) {
      updates.slug = await uniqueSlug(slugify(updates.name), req.params.id);
    }

    // Auto-create category if it doesn't exist (collision-safe slug handling)
    if (updates.category) {
      await Category.findOrCreateCategory(updates.category);
    }

    const product = await Product.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // Out-of-stock detection when admin sets stock to 0
    const io = req.app.get("io");
    if (product.stock === 0) {
      product.pendingDeleteAt = new Date(Date.now() + 2 * 60 * 1000);
      await product.save();
      scheduleDeletion(product._id, io);
      if (io) {
        io.emit("product_out_of_stock", {
          productId: product._id.toString(),
          name: product.name,
          category: product.category,
          pendingDeleteAt: product.pendingDeleteAt,
        });
      }
    } else if (product.stock > 0 && product.pendingDeleteAt) {
      product.pendingDeleteAt = null;
      await product.save();
      cancelDeletion(product._id);
    }

    try {
      const { logActivity } = require("../utils/activityLogger");
      await logActivity({
        user: req.user,
        action: "PRODUCT_UPDATED",
        description: \`Updated product "\${product.name}" (\${product._id})\`,
        req,
      });
    } catch {}

    if (io) {
      io.emit("products_updated", { source: "product-update", updated: 1, productId: product._id.toString() });
    }

    return res.status(200).json({ success: true, product });
  } catch (err) {
    console.error("updateProduct error:", err);
    return res.status(500).json({ success: false, message: "Failed to update product." });
  }
};

`;

cut("// PUT /api/products/:id  (admin only)", "// DELETE /api/products/:id  (admin only)", newUpdate);

fs.writeFileSync(file, s);
console.log("spliced ok, lines:", s.split("\n").length);
