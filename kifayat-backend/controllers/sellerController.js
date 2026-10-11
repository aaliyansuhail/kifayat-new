const Product = require("../models/Product");
const ShipmentRecord = require("../models/ShipmentRecord");
const ProductInteraction = require("../models/ProductInteraction");
const Category = require("../models/Category");
const { slugify, uniqueSlug, invalidateProductListCache, nextProductId } = require("./productController");
const { generateKeywords } = require("../utils/seoKeywords");

const MAX_IMAGES = 10;
const MAX_VIDEOS = 3;
const MAX_VARIATIONS = 30;

class SellerInputError extends Error {}

const str = (value, max = 500) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Split a comma/newline separated URL list into clean, de-duplicated URLs. */
const parseUrlList = (value, limit = MAX_IMAGES + MAX_VIDEOS) => {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const url = str(item, 1000);
    if (!url) continue;
    const clean = url.split("?")[0].trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
};

const isVideoUrl = (url) => /\.(mp4|webm|mov|m4v|ogg)(\?|$)/i.test(url);

/**
 * Normalise a seller-supplied product into the same document shape the
 * store's own catalogue uses, so storefront rendering and the engagement
 * analytics work on seller listings without special cases.
 */
const normalizeSellerProduct = async (body = {}, { excludeId, isCreate = false } = {}) => {
  const name = str(body.name, 200);
  if (!name) throw new SellerInputError("Product name is required.");

  const category = str(body.category, 80) || "Uncategorized";
  await Category.findOrCreateCategory(category);

  const costPrice = num(body.costPrice);
  const stockFromBody = num(body.stock);
  const weight = num(body.weight);

  // Variations: keep only rows with a name and a usable price, and let them own
  // the product stock (variations drive availability).
  let variations = [];
  if (Array.isArray(body.variations)) {
    variations = body.variations
      .filter((v) => v && str(v.name, 200))
      .slice(0, MAX_VARIATIONS)
      .map((v, i) => {
        const vWholesale = num(v.costPrice, costPrice);
        const vRetail = num(v.salePrice ?? v.price ?? v.salePrice);
        const image = str(v.image ?? v.variation_image?.original_url, 1000);
        return {
          id: v.id ?? `seller-${i + 1}-${Date.now().toString(36)}`,
          name: str(v.name, 200),
          costPrice: vWholesale,
          salePrice: vRetail || undefined,
          price: vRetail || undefined,
          quantity: num(v.quantity),
          sku: str(v.sku, 80),
          ...(image ? { variation_image: { original_url: image } } : {}),
          attribute_values: [],
        };
      });
  }
  const variationStock = variations.reduce((sum, v) => sum + v.quantity, 0);
  const hasVariations = variations.length > 0;
  const stock = hasVariations ? variationStock : stockFromBody;

  // The seller must set the retail price explicitly: there are no supplier
  // cost-based pricing rules any more.
  const sale = num(body.salePrice);
  if (sale <= 0) {
    throw new SellerInputError("Sale price is required.");
  }

  // Media: uploaded or pasted image/video URLs → imageUrl comma list + a
  // gallery the product page can render, exactly like the imported catalogue.
  const videos = parseUrlList(body.videos ?? body.videoUrl)
    .filter(isVideoUrl)
    .slice(0, MAX_VIDEOS);
  const images = parseUrlList(body.images ?? body.imageUrl)
    .filter((u) => !isVideoUrl(u))
    .slice(0, MAX_IMAGES);
  const gallery = [
    ...images.map((url) => ({ id: null, url, type: "image" })),
    ...videos.map((url) => ({ id: null, url, type: "video" })),
  ];
  const imageUrl = images.join(",");

  const keywords = Array.isArray(body.keywords)
    ? body.keywords.map((k) => str(k, 80)).filter(Boolean).slice(0, 20)
    : str(body.keywords, 1000)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, 20);

  return {
    name,
    slug: await uniqueSlug(slugify(name), excludeId),
    description: str(body.description, 5000),
    category,
    // Fashion department — "unisex" shows under both Men and Women filters.
    gender: ["men", "women"].includes(String(body.gender || "").trim().toLowerCase())
      ? String(body.gender).trim().toLowerCase()
      : "unisex",
    sku: str(body.sku, 80),
    // Public id (kp-00000000001) — minted once on create, never reassigned.
    ...(excludeId
      ? {}
      : { productId: body.productId ? str(body.productId, 80) : await nextProductId() }),
    costPrice,
    salePrice: sale,
    stock,
    ...(isCreate ? { originalStock: stock } : {}),
    weight,
    imageUrl,
    videoUrl: videos.join(","),
    gallery,
    variations,
    keywords: keywords.length ? keywords : generateKeywords(name, category),
    seoTitle: str(body.seoTitle, 200),
    seoDescription: str(body.seoDescription, 500),
  };
};

// Get all products for the logged-in seller
const getSellerProducts = async (req, res) => {
  try {
    const sellerId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const products = await Product.find({ sellerId, deleted: { $ne: true } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Product.countDocuments({ sellerId, deleted: { $ne: true } });

    res.status(200).json({
      success: true,
      products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Get seller products error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch products.",
    });
  }
};

// Create a new product for the seller
const createSellerProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const sellerId = req.user._id;
    const normalized = await normalizeSellerProduct(req.body, { isCreate: true });

    const product = await Product.create({
      ...normalized,
      sellerId,
      hidden: false,
      featuredOnLanding: false,
      salesCount: 0,
    });

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product,
    });
  } catch (err) {
    if (err instanceof SellerInputError) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error("Create seller product error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create product.",
    });
  }
};

// Update a seller's product
const updateSellerProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const { id } = req.params;
    const sellerId = req.user._id;

    const product = await Product.findOne({ _id: id, sellerId, deleted: { $ne: true } });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found or you don't have permission to update it.",
      });
    }

    const normalized = await normalizeSellerProduct(req.body, { excludeId: product._id });
    Object.assign(product, normalized);
    await product.save();

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      product,
    });
  } catch (err) {
    if (err instanceof SellerInputError) {
      return res.status(400).json({ success: false, message: err.message });
    }
    console.error("Update seller product error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to update product.",
    });
  }
};

// Delete a seller's product — soft delete, like every other product in the
// catalogue. It leaves the storefront immediately but keeps the row (and its
// click/hover history) so admin can restore it and the analytics still resolve
// a product name.
const deleteSellerProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const { id } = req.params;
    const sellerId = req.user._id;

    const product = await Product.findOne({ _id: id, sellerId, deleted: { $ne: true } });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found or you don't have permission to delete it.",
      });
    }

    product.deleted = true;
    product.deletedAt = new Date();
    await product.save();

    res.status(200).json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (err) {
    console.error("Delete seller product error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to delete product.",
    });
  }
};

// Get seller analytics
const getSellerAnalytics = async (req, res) => {
  try {
    const sellerId = req.user._id;

    const totalProducts = await Product.countDocuments({ sellerId, deleted: { $ne: true } });

    // Confirmed orders store a free-text productSearch token list (sku / public
    // id / name); there is no seller id on a shipment record, so attribute a
    // sale by matching the seller's own product tokens.
    const sellerProducts = await Product.find({ sellerId })
      .select("sku productId name")
      .lean();
    const tokens = [];
    for (const p of sellerProducts) {
      for (const t of [p.sku, p.productId, p.name]) {
        const v = String(t || "").trim().toLowerCase();
        if (v) tokens.push(v);
      }
    }

    const matched = tokens.length
      ? await ShipmentRecord.find({ productSearch: { $in: tokens } })
          .sort({ createdAt: -1 })
          .lean()
      : [];

    const totalSales = matched.length;
    const totalRevenue = matched.reduce((sum, o) => sum + (Number(o.sellPrice) || 0), 0);
    const totalItemsSold = matched.reduce((sum, o) => sum + (Number(o.productCount) || 0), 0);
    const recentOrders = matched.slice(0, 10);

    // Headline engagement numbers, all-time and for the last 30 days.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [allTime, last30, uniqueLast30] = await Promise.all([
      ProductInteraction.aggregate([
        { $match: { sellerId } },
        { $group: { _id: "$interactionType", count: { $sum: 1 } } },
      ]),
      ProductInteraction.aggregate([
        { $match: { sellerId, createdAt: { $gte: thirtyDaysAgo } } },
        { $group: { _id: "$interactionType", count: { $sum: 1 } } },
      ]),
      ProductInteraction.aggregate([
        { $match: { sellerId, createdAt: { $gte: thirtyDaysAgo } } },
        {
          $group: {
            _id: null,
            // One person counts once: signed-in shoppers collapse onto their
            // account id instead of adding a session on top of it.
            visitors: {
              $addToSet: {
                $concat: [
                  { $cond: [{ $eq: [{ $type: "$userId" }, "objectId"] }, "u:", "s:"] },
                  {
                    $ifNull: [
                      { $toString: "$userId" },
                      { $ifNull: [{ $toString: "$sessionId" }, "anonymous"] },
                    ],
                  },
                ],
              },
            },
          },
        },
      ]),
    ]);

    const countBy = (rows, type) => rows.find((r) => r._id === type)?.count || 0;
    const interactions = {
      allTime: {
        views: countBy(allTime, "view"),
        clicks: countBy(allTime, "click"),
        hovers: countBy(allTime, "hover"),
        pageviews: countBy(allTime, "pageview"),
      },
      last30Days: {
        views: countBy(last30, "view"),
        clicks: countBy(last30, "click"),
        hovers: countBy(last30, "hover"),
        pageviews: countBy(last30, "pageview"),
        uniqueVisitors: uniqueLast30[0]?.visitors?.length || 0,
      },
    };

    res.status(200).json({
      success: true,
      analytics: {
        totalProducts,
        totalSales,
        totalRevenue,
        totalItemsSold,
        recentOrders,
        interactions,
      },
    });
  } catch (err) {
    console.error("Get seller analytics error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch analytics.",
    });
  }
};

module.exports = {
  getSellerProducts,
  createSellerProduct,
  updateSellerProduct,
  deleteSellerProduct,
  getSellerAnalytics,
};
