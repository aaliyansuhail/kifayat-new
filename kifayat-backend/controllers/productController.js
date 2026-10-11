const mongoose = require("mongoose");
const Groq = require("groq-sdk");
const Product = require("../models/Product");
const User = require("../models/User");
const Settings = require("../models/Settings");
const Report = require("../models/Report");
const Category = require("../models/Category");
const OutOfStockDeletedProduct = require("../models/OutOfStockDeletedProduct");
const PreOrder = require("../models/PreOrder");
const ShipmentRecord = require("../models/ShipmentRecord");
const TrendingSearch = require("../models/TrendingSearch");
const { optimizeProductCopy } = require("../utils/groqProductOptimizer");
const groqKeyPool = require("../utils/groqKeyPool");
const { generateKeywords } = require("../utils/seoKeywords");

// ── Keyword map: slug → name fragments to match against product names ─────────
// Used by the category filter in getProducts. Kept in sync with utils/categorize.js.
// STRONG keywords only: the weak list holds generic modifiers ("watch", "bag",
// "smart", "home") which, matched as bare substrings, dragged unrelated
// products into a category — e.g. an Electronics "Classic Steel Smartwatch"
// showed up under Fashion because of "watch".
const { CATEGORIES, categorizeProduct } = require("../utils/categorize");
const CATEGORY_KEYWORDS = Object.fromEntries(
  CATEGORIES.map((c) => [c.slug, [...(c.strong || [])]])
);

// ── Public catalogue list cache ─────────────────────────────────────────────
// Product list responses are cached in-memory for a short TTL. Products change
// rarely and the cache is cleared on every mutation, so repeat visitors never
// pay the cost of scanning the catalogue.
const LIST_CACHE_TTL = 30_000;
const MAX_LIST_CACHE_ENTRIES = 500;
const listCache = new Map(); // key -> { at, payload }
function getCachedList(key) {
  const entry = listCache.get(key);
  if (entry && Date.now() - entry.at < LIST_CACHE_TTL) return entry.payload;
  if (entry) listCache.delete(key);
  return null;
}
function setCachedList(key, payload) {
  if (listCache.size >= MAX_LIST_CACHE_ENTRIES) {
    const oldest = listCache.keys().next().value;
    if (oldest !== undefined) listCache.delete(oldest);
  }
  listCache.set(key, { at: Date.now(), payload });
}
function invalidateProductListCache() {
  listCache.clear();
}
function listCacheControl(res) {
  return res.set("Cache-Control", "public, max-age=30, s-maxage=60");
}

// ── Lean projection for catalogue lists ──────────────────────────────────────
// Only fields needed to render product cards / catalogue rows. Excludes heavy
// blobs (gallery, variations, costPrice) so list
// queries avoid dragging the full document across the wire.
const LIST_PROJECTION = {
  _id: 1,
  name: 1,
  slug: 1,
  salePrice: 1,
  price: 1,
  imageUrl: 1,
  stock: 1,
  inStock: 1,
  category: 1,
  createdAt: 1,
  salesCount: 1,
  sku: 1,
  weight: 1,
  videoUrl: 1,
  productId: 1,
  updatedAt: 1,
  featuredOnLanding: 1,
  featuredOrder: 1,
  // Lets the storefront tell seller-owned products apart so engagement tracking
  // only fires for products that actually belong to a seller.
  sellerId: 1,
  // Fashion department (men / women / unisex) — drives the storefront's
  // Men/Women filter badges and the admin list.
  gender: 1,
};

// ── Shared availability ─────────────────────────────────────────────────────
// A listing is in stock purely from the admin's on/off toggle. When the
// listing has variations (size / colour options) it is in stock while at
// least one option is enabled. There is no quantity anywhere.
function productAvailability(product) {
  const variations = Array.isArray(product?.variations) ? product.variations : [];
  if (variations.length > 0) {
    return { inStock: variations.some((v) => v?.inStock !== false) };
  }
  // Explicit toggle wins; fall back to the legacy numeric field for records
  // written before the toggle existed.
  const inStock =
    product?.inStock !== undefined && product?.inStock !== null
      ? product.inStock !== false
      : Number(product?.stock ?? 0) > 0;
  return { inStock };
}

// ── Normalize the admin-entered size/colour options ─────────────────────────
// Each option is just { id, name, size, color, salePrice, inStock } — no
// quantity. The selectable label is the colour/size combination (or an
// explicit free-text name).
function normalizeVariations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v, i) => {
      if (!v || typeof v !== "object") return null;
      const name = String(v.name ?? "").trim();
      const size = String(v.size ?? "").trim();
      const color = String(v.color ?? "").trim();
      if (!name && !size && !color) return null;
      return {
        id: String(v.id ?? `var-${i + 1}`),
        name: name || [color, size].filter(Boolean).join(" ").trim(),
        size,
        color,
        salePrice: Number(v.salePrice ?? v.price ?? 0) || 0,
        inStock: v.inStock !== false,
      };
    })
    .filter(Boolean);
}

// ── Strip exact stock + private cost price from customer-facing responses ────
function toCustomerProduct(product) {
  if (!product) return product;
  const obj = product.toObject ? product.toObject() : { ...product };
  obj.inStock = productAvailability(obj).inStock;
  delete obj.stock;
  delete obj.newProduct;
  delete obj.rawData;
  delete obj.hidden;
  delete obj.costPrice;
  if (Array.isArray(obj.variations)) {
    obj.variations = obj.variations.map((v) => {
      const clone = v && typeof v === "object" ? { ...v } : v;
      if (clone && typeof clone === "object") {
        delete clone.costPrice;
        // No quantities reach the storefront — just the in/out-of-stock flag.
        delete clone.quantity;
        clone.inStock = clone.inStock !== false;
      }
      return clone;
    });
  }
  return obj;
}

// ── Normalizers ───────────────────────────────────────────────────────────────
const norm = (s) => (s || "").toLowerCase().replace(/[\s\-_()/?]+/g, "");

const slugify = (name) => {
  if (!name) return "";
  // Step 1: standard slug (strip non-ASCII, collapse whitespace/hyphens)
  let slug = name
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 200);
  if (slug) return slug;
  // Step 2: fallback — keep any surviving word chars after stripping
  slug = name
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\W+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 200);
  if (slug) return slug;
  // Step 3: last resort — guaranteed-unique timestamp slug
  return `product-${Date.now().toString(36)}`;
};

// ── Unique slug generator — appends -2, -3, … on collision ──────────────────
const uniqueSlug = async (base, excludeId) => {
  let slug = base || `product-${Date.now().toString(36)}`;
  for (let suffix = 2; suffix <= 1000; suffix++) {
    const q = { slug };
    if (excludeId) q._id = { $ne: excludeId };
    const exists = await Product.findOne(q).lean();
    if (!exists) break;
    slug = `${base}-${suffix}`;
  }
  return slug;
};

const decodeEntities = (str) => {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
};

const takeFirst = (val) => {
  if (!val) return "";
  return val.split(",")[0].trim();
};

const pick = (row, ...variants) => {
  const r = {};
  Object.keys(row).forEach((k) => {
    r[norm(k)] = (row[k] || "").trim();
  });
  for (const v of variants) {
    const val = r[norm(v)];
    if (val !== undefined && val !== "") return val;
  }
  return "";
};

const parseNum = (str) => {
  const n = parseFloat((str || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) || n < 0 ? 0 : n;
};

const parseIntSafe = (str) => {
  const n = parseInt((str || "").replace(/[^0-9]/g, ""), 10);
  return isNaN(n) || n < 0 ? 0 : n;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/products/manual  (admin only)
// Creates one catalogue product from the admin "Add Product" form.
//
// Required: name, description, cost price, sale price, stock, at least
// 3 images and at least 1 video. Products get a sequential public id:
// kp-00000000001, kp-00000000002, …
// ─────────────────────────────────────────────────────────────────────────────
const MIN_PRODUCT_IMAGES = 3;

function normalizeUrlList(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]/)
      : [];
  return list.map((u) => String(u || "").trim()).filter(Boolean);
}

// Build the ordered product media list: images first, then the video.
function buildGallery(product) {
  const gallery = Array.isArray(product?.gallery) ? product.gallery.filter(Boolean) : [];
  if (gallery.length > 0) return gallery;
  const images = Array.isArray(product?.images) ? product.images.filter(Boolean) : [];
  const items = images.map((url, i) => ({ id: `image-${i + 1}`, url, type: "image" }));
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
  return `kp-${String(seq).padStart(11, "0")}`;
}

const createManualProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const body = req.body || {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const costPrice = Number(body.costPrice);
    const salePrice = Number(body.salePrice);
    const inStock = body.inStock !== false;
    const variations = normalizeVariations(body.variations);
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
    const gender = normalizeGender(body.gender);

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
    if (!Number.isFinite(weightNum) || weightNum < 0) {
      return res.status(400).json({ success: false, message: "Weight must be a number greater than or equal to 0." });
    }
    if (images.length < MIN_PRODUCT_IMAGES) {
      return res
        .status(400)
        .json({ success: false, message: `At least ${MIN_PRODUCT_IMAGES} product images are required.` });
    }
    if (!video) {
      return res.status(400).json({ success: false, message: "A product video is required." });
    }

    // ── Category + identity ─────────────────────────────────────────────────
    await Category.findOrCreateCategory(cat);
    const productId = await nextProductId();
    const slug = await uniqueSlug(slugify(name));

    const gallery = [
      ...images.map((url, i) => ({ id: `image-${i + 1}`, url, type: "image" })),
      { id: "video-1", url: video, type: "video" },
    ];

    const doc = await Product.create({
      productId,
      name,
      slug,
      description,
      costPrice,
      salePrice,
      inStock,
      variations,
      stock: inStock ? 1 : 0,
      originalStock: inStock ? 1 : 0,
      weight: weightNum,
      images,
      video,
      imageUrl: images[0],
      videoUrl: video,
      gallery,
      category: cat,
      gender,
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
      message: `Product ${productId} created and published.`,
      product: doc.toPublicObject(),
    });
  } catch (err) {
    console.error("createManualProduct error:", err);
    return res.status(500).json({ success: false, message: "Server error while creating product." });
  }
};

// GET /api/products  (all authenticated users)
// ─────────────────────────────────────────────────────────────────────────────
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Regex that matches a category's strong keywords inside a product name.
 * Single words are anchored with word boundaries so "mug" cannot fire inside
 * "smuggle" and "pan" cannot fire inside "pantaloon". Returns null when the
 * category has no strong keywords (then only the stored category is matched).
 */
const categoryNamePattern = (slug) => {
  const keywords = CATEGORY_KEYWORDS[String(slug || "").toLowerCase()] || [];
  const parts = keywords.map((kw) =>
    /[\s-]/.test(kw) ? escapeRegex(kw) : `\\b${escapeRegex(kw)}\\b`,
  );
  return parts.length ? parts.join("|") : null;
};

/**
 * Coerce a customer/admin supplied gender into the stored vocabulary.
 * Anything unrecognised becomes "unisex" — never a validation failure, so a
 * legacy client sending "" or "Men" cannot break a product save.
 */
const normalizeGender = (value) => {
  const g = String(value ?? "").trim().toLowerCase();
  if (g === "men" || g === "male" || g === "men's") return "men";
  if (g === "women" || g === "female" || g === "women's") return "women";
  return "unisex";
};

/**
 * Mongo clause for a gender filter. "unisex" items appear under both Men and
 * Women, and products stored before the field existed (missing/null) are
 * treated as unisex too, so the filter never hides the whole catalogue.
 */
const genderQueryClause = (value) => {
  const g = String(value ?? "").trim().toLowerCase();
  if (g !== "men" && g !== "women") return null;
  return {
    $or: [
      { gender: g },
      { gender: "unisex" },
      { gender: { $exists: false } },
      { gender: null },
      { gender: "" },
    ],
  };
};

// Applies brand + price filters to a MongoDB query object. Shared by BOTH the
// $text search path and the $regex fallback path so `total`/`pages` always
// reflect the same filtered set. Extra $and clauses combine cleanly with
// top-level $text, $or and the nested category $and used above.
const applySearchFilters = (targetQuery, { brand, minPrice, maxPrice }) => {
  const conditions = [];

  if (brand) {
    // Product has no brand field; replicate the removed frontend hack
    // (name.toLowerCase().includes(brand)) as a case-insensitive substring regex.
    conditions.push({ name: { $regex: escapeRegex(brand), $options: "i" } });
  }

  const price = {};
  if (minPrice != null) price.$gte = minPrice;
  if (maxPrice != null) price.$lte = maxPrice;
  if (Object.keys(price).length > 0) {
    conditions.push({ salePrice: price });
  }

  if (conditions.length === 0) return;
  if (Array.isArray(targetQuery.$and)) {
    targetQuery.$and.push(...conditions);
  } else {
    targetQuery.$and = conditions;
  }
};

const getProducts = async (req, res) => {
  try {
    const {
      search = "",
      sort = "",
      page = 1,
      limit = 60,
      category = "",
      brand = "",
      min_price,
      max_price,
      seller,
      sellers_only,
      gender: genderFilter,
    } = req.query;
    const query = { hidden: { $ne: true }, deleted: { $ne: true } };
    let textScoreSort = false;

    // Serve repeat requests from the short-lived list cache.
    const listKey = req.originalUrl;
    const cached = getCachedList(listKey);
    if (cached) {
      return listCacheControl(res).status(200).json(cached);
    }

    // Parse price bounds: ignore NaN/negative; 0 or absent means "no bound".
    const rawMinPrice = parseFloat(min_price);
    const rawMaxPrice = parseFloat(max_price);
    const minPrice = Number.isFinite(rawMinPrice) && rawMinPrice > 0 ? rawMinPrice : null;
    const maxPrice = Number.isFinite(rawMaxPrice) && rawMaxPrice > 0 ? rawMaxPrice : null;

    if (search) {
      const sanitized = search.trim();
      // Try $text search first (relevance-ranked, handles stemming & partial words)
      query.$text = { $search: sanitized };
      textScoreSort = true;
    }

    // Record the search term for trending suggestions — fire-and-forget, never
    // awaited so a Mongo hiccup can't slow or fail the product response.
    const recordedTerm = (search || "").trim();
    if (recordedTerm) {
      TrendingSearch.findOneAndUpdate(
        { term: recordedTerm.toLowerCase() },
        { $inc: { count: 1 }, $set: { lastSearchedAt: new Date() } },
        { upsert: true },
      )
        .exec()
        .catch((err) =>
          console.error("Failed to record trending search:", err?.message || err),
        );
    }

    if (category) {
      const cat = await Category.findOne({ slug: category }).lean();

      const orConditions = [];

      if (cat) {
        orConditions.push({ category: cat.name });
      }
      const slugPattern = escapeRegex(category).replace(/-/g, "[\\s\\-&]+");
      orConditions.push({ category: { $regex: slugPattern, $options: "i" } });

      const namePattern = categoryNamePattern(category);
      if (namePattern) {
        orConditions.push({ name: { $regex: namePattern, $options: "i" } });
      }

      if (query.$text) {
        const textClause = { $text: query.$text };
        delete query.$text;
        query.$and = [{ $or: [textClause] }, { $or: orConditions }];
        textScoreSort = true;
      } else {
        query.$or = orConditions;
      }
    }

    // Apply brand/price filters to the primary ($text) query BEFORE counting so
    // total/pages reflect the filtered result set.
    applySearchFilters(query, { brand, minPrice, maxPrice });    // "Seller products only" — products a seller listed themselves, excluding
    // the store's own catalogue. Drives the navbar store button, which every
    // customer sees regardless of whether they are signed in.
    if (sellers_only === "true" || sellers_only === "1") {
      query.sellerId = { $exists: true, $ne: null };
    }

    // Filter by seller if specified
    if (seller) {
      const User = require("../models/User");
      const sellerUser = await User.findOne({ email: seller.toLowerCase() }).lean();
      if (sellerUser) {
        query.sellerId = sellerUser._id;
      } else {
        // Unknown seller must render an EMPTY storefront, never the whole
        // catalogue. Leaving the filter off — or matching "no sellerId" — would
        // silently list every product instead.
        query.sellerId = null;
        query._id = null;
      }
    }

    // Department filter (Fashion → Men / Women). Combined via $and so it never
    // clobbers the category $or or the $text clause set above.
    const genderClause = genderQueryClause(genderFilter);
    if (genderClause) {
      query.$and = [...(query.$and || []), genderClause];
    }

    const sortMap = {
      price_asc: { salePrice: 1 },
      price_desc: { salePrice: -1 },
      name_asc: { name: 1 },
      name_desc: { name: -1 },
      trending: { salesCount: -1 },
      oldest: { createdAt: 1 },
    };
    let sortObj = sortMap[sort] || { page: 1, createdAt: -1 };
    if (textScoreSort && !sort) {
      sortObj = { score: { $meta: "textScore" } };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    let projection = { ...LIST_PROJECTION };
    if (textScoreSort) {
      projection = { ...LIST_PROJECTION, score: { $meta: "textScore" } };
    }

    const [products, total] = await Promise.all([
      Product.find(query, projection)
        .skip(skip)
        .limit(limitNum)
        .sort(sortObj)
        .lean(),
      Product.countDocuments(query),
    ]);

    // If $text returned no results, fall back to $regex (substring/partial matching)
    if (search && products.length === 0) {
      const regexQuery = { hidden: { $ne: true }, deleted: { $ne: true } };
      const escaped = escapeRegex(search.trim());
      regexQuery.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { description: { $regex: escaped, $options: "i" } },
        { sku: { $regex: escaped, $options: "i" } },
        { productId: { $regex: escaped, $options: "i" } },
        // Per-product SEO keywords (e.g. "best hand gripper") — substring match
        { keywords: { $regex: escaped, $options: "i" } },
      ];

      if (category) {
        const cat = await Category.findOne({ slug: category }).lean();
        const orConditions = [];
        if (cat) orConditions.push({ category: cat.name });
        const slugPattern = escapeRegex(category).replace(/-/g, "[\\s\\-&]+");
        orConditions.push({ category: { $regex: slugPattern, $options: "i" } });
        const namePattern = categoryNamePattern(category);
        if (namePattern) {
          orConditions.push({ name: { $regex: namePattern, $options: "i" } });
        }
        if (regexQuery.$or) {
          regexQuery.$and = [{ $or: regexQuery.$or }, { $or: orConditions }];
          delete regexQuery.$or;
        } else {
          regexQuery.$or = orConditions;
        }
      }

      // Apply brand/price filters to the $regex fallback path too, so fallback
      // total/pages match the same filtered result set as the $text path.
      applySearchFilters(regexQuery, { brand, minPrice, maxPrice });

      // The department (gender) filter must survive the fallback too — without
      // this, a search inside Fashion silently listed both Men and Women items.
      if (genderClause) {
        regexQuery.$and = [...(regexQuery.$and || []), genderClause];
      }

      const fallbackSortObj = sortMap[sort] || { page: 1, createdAt: -1 };
      const [fallbackProducts, fallbackTotal] = await Promise.all([
        Product.find(regexQuery, LIST_PROJECTION)
          .skip(skip)
          .limit(limitNum)
          .sort(fallbackSortObj)
          .lean(),
        Product.countDocuments(regexQuery),
      ]);

      const safeFallback = fallbackProducts.map(toCustomerProduct);
      const payload = {
        success: true,
        products: safeFallback,
        total: fallbackTotal,
        page: pageNum,
        pages: Math.ceil(fallbackTotal / limitNum),
      };
      setCachedList(listKey, payload);
      return listCacheControl(res).status(200).json(payload);
    }

    const safeProducts = products.map(toCustomerProduct);

    const payload = {
      success: true,
      products: safeProducts,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    };
    setCachedList(listKey, payload);
    return listCacheControl(res).status(200).json(payload);
  } catch (err) {
    console.error("getProducts error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch products." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/suggest?q=&limit=  (public)
// Returns { queries, products }: query suggestions derived from product-name
// prefix matches (ordered by salesCount, deduped, capped at limit) plus a lean
// set of matching products using the same $text search as getProducts.
// ─────────────────────────────────────────────────────────────────────────────
const getSuggestions = async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const rawLimit = parseInt(req.query.limit, 10);
    const limitVal = Math.min(20, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 5));

    if (!q) {
      return res.status(200).json({ success: true, queries: [], products: [] });
    }

    // Products — same $text search as getProducts, with the same $regex
    // fallback when $text finds nothing (prefix/partial name matching).
    const searchQuery = { hidden: { $ne: true } };
    let products = [];
    if (q) {
      searchQuery.$text = { $search: q };
      products = await Product.find(searchQuery, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .limit(limitVal)
        .lean();
      if (products.length === 0) {
        const qEscaped = escapeRegex(q);
        products = await Product.find({
          hidden: { $ne: true },
          $or: [
            { name: { $regex: qEscaped, $options: "i" } },
            // Per-product SEO keywords (e.g. "best hand gripper") — substring match
            { keywords: { $regex: qEscaped, $options: "i" } },
          ],
        })
          .sort({ salesCount: -1 })
          .limit(limitVal)
          .lean();
      }
    }

    // Queries — product names that START with the typed prefix, best-selling
    // first; dedupe and cap at the same limit.
    const qEscaped = escapeRegex(q);
    const nameMatches = await Product.find({
      hidden: { $ne: true },
      name: { $regex: `^${qEscaped}`, $options: "i" },
    })
      .sort({ salesCount: -1, name: 1 })
      .limit(100)
      .lean();

    const queries = [];
    const seen = new Set();
    for (const p of nameMatches) {
      const name = (p.name || "").trim();
      if (!name) continue;
      // Suggest the full product name, truncated only for very long titles.
      const suggestion = name.length > 60 ? name.slice(0, 60).trim() : name;
      const key = suggestion.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(suggestion);
      if (queries.length >= limitVal) break;
    }

    const safeProducts = products.map(toCustomerProduct);
    return res.status(200).json({ success: true, queries, products: safeProducts });
  } catch (err) {
    console.error("getSuggestions error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch suggestions." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/trending-searches?limit=  (public)
// Returns the most-searched terms [{ term, count }] from TrendsSearch,
// ordered by count DESC.
// ─────────────────────────────────────────────────────────────────────────────
const getTrendingSearches = async (req, res) => {
  try {
    const rawLimit = parseInt(req.query.limit, 10);
    const limitVal = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 10));
    const trending = await TrendingSearch.find({})
      .sort({ count: -1 })
      .limit(limitVal)
      .lean();
    const rows = trending.map((t) => ({ term: t.term, count: t.count }));
    return res.status(200).json({ success: true, trending: rows });
  } catch (err) {
    console.error("getTrendingSearches error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch trending searches." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/leaderboard  (admin only)
// Returns products sorted by salesCount DESC.
// ─────────────────────────────────────────────────────────────────────────────
const getLeaderboard = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 0;
    let q = Product.find({})
      .sort({ salesCount: -1, name: 1 })
      .select(
        "name category salePrice stock originalStock salesCount imageUrl sku productId createdAt",
      );
    if (limit > 0) q = q.limit(Math.min(limit, 5000));
    const products = await q;

    return res.status(200).json({ success: true, products });
  } catch (err) {
    console.error("getLeaderboard error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch leaderboard." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/report  (admin only)
//
// Returns current period status OR the completed monthly report.
// If 30 days have elapsed and no report exists yet, auto-generates it
// and starts a fresh 30-day period automatically.
// ─────────────────────────────────────────────────────────────────────────────
const getReport = async (req, res) => {
  try {
    const settings = await Settings.findOne({});

    if (!settings || !settings.periodStart) {
      return res.status(200).json({
        success: true,
        status: "no_period",
        message:
          "No report period started yet. Add a product to begin the 30-day tracking period.",
      });
    }

    const now = new Date();
    const periodEnd = new Date(settings.periodEnd);
    const isComplete = now >= periodEnd;
    const msRemaining = Math.max(0, periodEnd - now);
    const daysLeft = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
    const daysElapsed = 30 - daysLeft;

    // ── Period still running ──────────────────────────────────────────────────
    if (!isComplete) {
      const products = await Product.find({})
        .sort({ salesCount: -1, name: 1 })
        .select("name sku category salePrice salesCount productId");

      const snapshot = settings.salesSnapshot || {};

      // Calculate sales IN this period for each product
      const standings = products
        .map((p) => ({
          name: p.name,
          sku: p.sku,
          category: p.category,
          salePrice: p.salePrice,
          periodSales: p.salesCount - (snapshot[p._id.toString()] || 0),
          totalSales: p.salesCount,
        }))
        .sort((a, b) => b.periodSales - a.periodSales)
        .map((p, i) => ({ rank: i + 1, ...p }));

      return res.status(200).json({
        success: true,
        status: "ongoing",
        periodNumber: settings.periodNumber,
        periodStart: settings.periodStart,
        periodEnd: settings.periodEnd,
        daysElapsed,
        daysLeft,
        standings,
      });
    }

    // ── Period complete — get or generate report ───────────────────────────────
    let report = await Report.findOne({ periodNumber: settings.periodNumber });

    if (!report) {
      // Auto-generate the report
      const products = await Product.find({})
        .sort({ salesCount: -1, name: 1 })
        .select("name sku category salePrice salesCount productId");

      const snapshot = settings.salesSnapshot || {};

      const ranked = products
        .map((p) => ({
          name: p.name,
          sku: p.sku,
          category: p.category,
          salePrice: p.salePrice,
          periodSales: p.salesCount - (snapshot[p._id.toString()] || 0),
          totalSales: p.salesCount,
        }))
        .sort((a, b) => b.periodSales - a.periodSales)
        .map((p, i) => ({ rank: i + 1, ...p }));

      const topProduct = ranked[0] || null;
      const totalPeriodSales = ranked.reduce((s, p) => s + p.periodSales, 0);

      report = await Report.create({
        periodNumber: settings.periodNumber,
        startDate: settings.periodStart,
        endDate: settings.periodEnd,
        generatedAt: now,
        topProduct: topProduct
          ? {
              name: topProduct.name,
              sku: topProduct.sku,
              category: topProduct.category,
              periodSales: topProduct.periodSales,
              totalSales: topProduct.totalSales,
              salePrice: topProduct.salePrice,
            }
          : null,
        products: ranked,
        totalPeriodSales,
      });

      // Auto-start the next 30-day period using current salesCounts as new snapshot
      const newSnapshot = {};
      products.forEach((p) => {
        newSnapshot[p._id.toString()] = p.salesCount;
      });

      await Settings.findOneAndUpdate(
        {},
        {
          periodNumber: settings.periodNumber + 1,
          periodStart: now,
          periodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
          salesSnapshot: newSnapshot,
        },
      );
    }

    return res.status(200).json({
      success: true,
      status: "complete",
      report,
    });
  } catch (err) {
    console.error("getReport error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to generate report." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/reports  (admin only)
// Returns all historical completed reports, newest first.
// ─────────────────────────────────────────────────────────────────────────────
const getAllReports = async (req, res) => {
  try {
    const reports = await Report.find({}).sort({ periodNumber: -1 });
    return res.status(200).json({ success: true, reports });
  } catch (err) {
    console.error("getAllReports error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch reports." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/stats  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
const getStats = async (req, res) => {
  try {
    const [total, totalUsers, outOfStock, categories, topSold] = await Promise.all([
      Product.countDocuments(),
      User.countDocuments(),
      Product.countDocuments({ inStock: false }),
      Product.distinct("category"),
      Product.findOne({}).sort({ salesCount: -1 }).select("name salesCount"),
    ]);

    return res.status(200).json({
      success: true,
      totalProducts: total,
      totalUsers,
      total,
      outOfStock,
      inStock: total - outOfStock,
      categories: categories.filter(Boolean).length,
      topSold: topSold
        ? { name: topSold.name, salesCount: topSold.salesCount }
        : null,
    });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch stats." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/products  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
const clearProducts = async (req, res) => {
  try {
    const result = await Product.deleteMany({});
    const OutOfStockDeletedProduct = require("../models/OutOfStockDeletedProduct");
    const Category = require("../models/Category");
    await OutOfStockDeletedProduct.deleteMany({});
    await Category.deleteMany({});
    // Only clear the sales snapshot — keep reports and the current period intact
    await Settings.findOneAndUpdate({}, { salesSnapshot: {} });

    // Emit event so frontend can show skeleton state
    const io = req.app.get("io");
    if (io) {
      io.emit("products_cleared", { message: "All products have been cleared by admin." });
    }

    return res.status(200).json({
      success: true,
      message: `All products cleared. ${result.deletedCount} products removed. Reports and tracking period preserved.`,
      deletedCount: result.deletedCount,
    });
  } catch (err) {
    console.error("clearProducts error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to clear products." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/:id  (single product detail)
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

// GET /api/products/:id/similar
// Returns top 6 similar products by category + name keyword matching + sales.
// ─────────────────────────────────────────────────────────────────────────────
const getSimilarProducts = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    const similar = await Product.find({
      _id: { $ne: product._id },
      category: product.category || "Uncategorized",
    })
      .sort({ salesCount: -1, createdAt: -1 })
      .limit(6)
      .lean();

    const safeProducts = similar.map(toCustomerProduct);
    return res.status(200).json({ success: true, products: safeProducts });
  } catch (err) {
    console.error("getSimilarProducts error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch similar products." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/products/:id/stock  (admin only)
// Sets the in/out-of-stock toggle. A legacy `change` (+1/-1) is still accepted
// from older cart flows and mapped onto the toggle.
// ─────────────────────────────────────────────────────────────────────────────
const updateStock = async (req, res) => {
  invalidateProductListCache();
  try {
    const { inStock, change } = req.body || {};

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    let next;
    if (typeof inStock === "boolean") {
      next = inStock;
    } else if (typeof change === "number" && change !== 0) {
      next = (Number(product.stock) || 0) + change > 0;
    } else {
      return res.status(400).json({ success: false, message: "Invalid stock value." });
    }

    product.inStock = next;
    product.stock = next ? 1 : 0;
    product.stockOutAt = next ? null : new Date();
    product.pendingDeleteAt = null;
    await product.save();

    const io = req.app.get("io");
    if (io) {
      io.emit("products_updated", { source: "stock", productId: product._id.toString() });
    }

    return res.status(200).json({ success: true, inStock: product.inStock });
  } catch (err) {
    console.error("updateStock error:", err);
    return res.status(500).json({ success: false, message: "Failed to update stock." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/products/:id  (admin only)
// Updates one product. costPrice stays private; every customer-facing price
// and discount is derived from salePrice.
// ─────────────────────────────────────────────────────────────────────────────
const updateProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const allowed = [
      "name", "description", "costPrice", "salePrice", "inStock", "variations",
      "images", "video", "imageUrl", "videoUrl", "gallery",
      "weight", "sku", "productId", "category", "gender",
      "hidden", "keywords", "seoTitle", "seoDescription", "featuredOnLanding",
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.inStock !== undefined) updates.inStock = updates.inStock !== false;
    if (updates.gender !== undefined) updates.gender = normalizeGender(updates.gender);
    if (updates.variations !== undefined) updates.variations = normalizeVariations(updates.variations);

    // Media validation: at least 3 images and exactly one video when provided.
    if (updates.images !== undefined) {
      const images = normalizeUrlList(updates.images);
      if (images.length < MIN_PRODUCT_IMAGES) {
        return res
          .status(400)
          .json({ success: false, message: `At least ${MIN_PRODUCT_IMAGES} product images are required.` });
      }
      updates.images = images;
      if (req.body.imageUrl === undefined) updates.imageUrl = images[0];
      if (req.body.gallery === undefined) {
        updates.gallery = [
          ...images.map((url, i) => ({ id: `image-${i + 1}`, url, type: "image" })),
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

    const io = req.app.get("io");

    try {
      const { logActivity } = require("../utils/activityLogger");
      await logActivity({
        user: req.user,
        action: "PRODUCT_UPDATED",
        description: `Updated product "${product.name}" (${product._id})`,
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

// DELETE /api/products/:id  (admin only)
// Soft-deletes a product — hidden from storefront and admin list but
// preserved in the database for the "Deleted Products" admin page.
// ─────────────────────────────────────────────────────────────────────────────
const deleteProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { deleted: true, deletedAt: new Date(), hidden: true },
      { new: true },
    );
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    try {
      const { logActivity } = require("../utils/activityLogger");
      await logActivity({
        user: req.user,
        action: "PRODUCT_DELETED",
        description: `Deleted product "${product.name}" (${product._id})`,
        req,
      });
    } catch {}

    const io = req.app.get("io");
    if (io) {
      io.emit("product_deleted", { productId: product._id.toString() });
    }

    return res.status(200).json({ success: true, message: `"${product.name}" has been deleted.` });
  } catch (err) {
    console.error("deleteProduct error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete product." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/deleted  (admin only)
// Lists soft-deleted products for the "Deleted Products" admin page.
// ─────────────────────────────────────────────────────────────────────────────
const getDeletedProducts = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const query = { deleted: true };
    if (search) {
      query.$or = [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { sku: { $regex: escapeRegex(search), $options: "i" } },
        { category: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const [products, total] = await Promise.all([
      Product.find(query).sort({ deletedAt: -1 }).skip(skip).limit(limitNum).lean(),
      Product.countDocuments(query),
    ]);

    return res.status(200).json({ success: true, products, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error("getDeletedProducts error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch deleted products." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/products/:id/restore  (admin only)
// Restores a soft-deleted product.
// ─────────────────────────────────────────────────────────────────────────────
const restoreProduct = async (req, res) => {
  invalidateProductListCache();
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { deleted: false, deletedAt: null },
      { new: true },
    );
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    try {
      const { logActivity } = require("../utils/activityLogger");
      await logActivity({
        user: req.user,
        action: "PRODUCT_UPDATED",
        description: `Restored deleted product "${product.name}" (${product._id})`,
        req,
      });
    } catch {}

    const io = req.app.get("io");
    if (io) {
      io.emit("products_updated", { source: "restore", productId: product._id.toString() });
    }

    return res.status(200).json({ success: true, message: `"${product.name}" has been restored.` });
  } catch (err) {
    console.error("restoreProduct error:", err);
    return res.status(500).json({ success: false, message: "Failed to restore product." });
  }
};

// GET /api/products/out-of-stock  (admin only)
// Returns all products that have been deleted due to out-of-stock.
// ─────────────────────────────────────────────────────────────────────────────
const getOutOfStockProducts = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
      OutOfStockDeletedProduct.find({})
        .sort({ deletedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      OutOfStockDeletedProduct.countDocuments({}),
    ]);

    return res.status(200).json({
      success: true,
      products,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("getOutOfStockProducts error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch out-of-stock products." });
  }
};

// GET /api/products/categories  (admin only)
// Returns all categories.
// ─────────────────────────────────────────────────────────────────────────────
let categoriesCache = null;
let categoriesCacheAt = 0;
const CATEGORIES_CACHE_TTL = 60_000;

const getCategories = async (req, res) => {
  try {
    const now = Date.now();
    if (categoriesCache && now - categoriesCacheAt < CATEGORIES_CACHE_TTL) {
      return res.status(200).json({ success: true, categories: categoriesCache });
    }
    const [categories, counts] = await Promise.all([
      Category.find({}).sort({ name: 1 }).lean(),
      Product.aggregate([
        { $match: { hidden: { $ne: true } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]),
    ]);
    // Live productCount — never trust the stored value, which goes stale as
    // products are imported/recategorized.
    const countMap = new Map(counts.map((c) => [c._id, c.count]));
    const withCounts = categories.map((c) => ({
      ...c,
      productCount: countMap.get(c.name) ?? 0,
    }));
    categoriesCache = withCounts;
    categoriesCacheAt = now;
    return res.status(200).json({ success: true, categories: withCounts });
  } catch (err) {
    console.error("getCategories error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch categories." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/products/categories/update-image  (admin only)
// Sets a category's image URL.
// ─────────────────────────────────────────────────────────────────────────────
const updateCategoryImage = async (req, res) => {
  try {
    const { slug, image } = req.body;
    if (!slug) {
      return res.status(400).json({ success: false, message: "Category slug is required." });
    }
    const category = await Category.findOneAndUpdate(
      { slug },
      { $set: { image: image || "" } },
      { new: true },
    );
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found." });
    }
    categoriesCache = null;
    return res.status(200).json({ success: true, category });
  } catch (err) {
    console.error("updateCategoryImage error:", err);
    return res.status(500).json({ success: false, message: "Failed to update category image." });
  }
};

// ── Get all orders for a product across PreOrder and ShipmentRecord ──
const getProductOrders = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid product ID." });
    }

    const product = await Product.findById(id).lean();
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    const sku = (product.sku || "").trim().toLowerCase();
    const name = (product.name || "").trim().toLowerCase();

    const skuOrNameMatch = (entry) => {
      const val = (entry || "").trim().toLowerCase();
      return val && (val === sku || val === name || (sku && val.includes(sku)));
    };

    const preOrders = await PreOrder.find({ "items.product": id })
      .sort({ createdAt: -1 })
      .lean();

    const mainOrders = await ShipmentRecord.find({
      productSearch: { $regex: sku || name, $options: "i" },
    })
      .sort({ createdAt: -1 })
      .lean()
      .then((orders) =>
        orders.filter((o) =>
          (o.productSearch || []).some((val) => skuOrNameMatch(val))
        )
      );

    const combined = [
      ...preOrders.map((o) => ({
        ...o,
        _orderType: "pre_order",
        _stage: "Pre Order",
      })),
      ...mainOrders.map((o) => ({
        ...o,
        _orderType: "main_order",
        _stage: "Main Order",
      })),
    ];

    combined.sort((a, b) => {
      const da = a.createdAt || a.exportedAt || 0;
      const db = b.createdAt || b.exportedAt || 0;
      return new Date(db) - new Date(da);
    });

    return res.status(200).json({ success: true, orders: combined, product });
  } catch (err) {
    console.error("getProductOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch orders." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/admin-list  (admin only)
// Returns full product documents — including stock, costPrice, hidden — for
// use exclusively in the admin panel. Not sanitised through toCustomerProduct.
// ─────────────────────────────────────────────────────────────────────────────
const getAdminProducts = async (req, res) => {
  try {
    const { search = "", page = 1, limit = 500 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(1000, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const query = { deleted: { $ne: true } };
    if (search) {
      query.$or = [
        { name: { $regex: escapeRegex(search), $options: "i" } },
        { sku: { $regex: escapeRegex(search), $options: "i" } },
        { category: { $regex: escapeRegex(search), $options: "i" } },
        { keywords: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const products = await Product.find(query)
      // Newest first — freshly imported/synced products (and quick-fetch
      // items with no page field) always appear at the top, never buried
      // at the end of the paginated admin list.
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const [total] = await Promise.all([
      Product.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      products,
      total,
      page: pageNum,
    });
  } catch (err) {
    console.error("getAdminProducts error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch products." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Groq AI categorization helpers
// ─────────────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES = ["Electronics", "Fashion", "Home"];
const GROQ_MODEL      = "llama-3.3-70b-versatile";
const GROQ_BATCH_SIZE = 20;  // products per Groq call

const GROQ_SYSTEM_PROMPT = `You are an expert product category classifier for a Pakistani e-commerce store.

Classify each product into EXACTLY ONE of these 3 categories:

Electronics → phones, laptops, TVs, earbuds/headphones/AirPods, cameras, chargers, cables, WiFi routers,
              power banks, smartwatches, speakers, drones, gaming consoles, printers, phone/laptop coolers,
              cordless drills, inverters, UPS, solar panels, washing machines, refrigerators, ACs, microwave ovens.

Fashion     → clothing (shirts, jeans, dresses, kurtas, abayas), shoes/sneakers/sandals, handbags, wallets,
              caps/hats, sunglasses, jewellery, watches, scarves, belts, socks, gloves,
              personal care & beauty: skincare (face wash, serum, moisturizer, sunscreen, face mask),
              haircare (shampoo, conditioner, hair oil, hair dryer, straightener, curling iron),
              makeup (lipstick, foundation, mascara, eyeliner, nail polish, makeup brushes),
              fragrance (perfume, eau de parfum, deodorant, body spray, attar), grooming devices
              (electric shaver, beard trimmer, epilator, facial massager), body lotion, hair removal.

Home        → bedding & bath (bedsheets, pillows, duvet covers, quilts, blankets, towels, bathrobes),
              kitchen appliances (air fryer, kettle, blender, rice cooker, coffee maker, sandwich maker,
              egg boiler, juicer, food chopper), cookware (pans, pots, woks), cutlery & utensils,
              food storage, dining ware, humidifiers, aroma diffusers, lamps (desk/floor/table/night/reading),
              home decor (showpieces, candles, vases, wall art, frames), furniture (chairs, tables, shelves),
              cushions, cleaning tools (mops, brooms), pest control (mosquito nets, mousetraps, rat traps),
              bathroom accessories, door/window seals, storage organizers, steam irons, neck/handheld fans,
              fitness & sports gear (dumbbells, yoga mats, resistance bands, treadmills, exercise bikes,
              massage guns, cricket/football/badminton gear, cycling, camping, protein supplements),
              toys & kids (children's toys, RC cars, dolls, building blocks, board games, puzzles, kids bikes).

RULES:
- Perfume, cologne, deodorant, body spray, attar → ALWAYS Fashion.
- Skincare, haircare, makeup, shavers and trimmers → Fashion.
- Kitchen scales, food scales → Home.
- Bedsheets, towels, blankets, pillows → Home.
- Portable/handheld/neck fans → Home (not Electronics).
- Massage guns, grip trainers, exercise bikes → Home.
- If truly ambiguous, prefer: Home > Fashion > Electronics.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask Groq to classify one batch of products.
 * Returns string[] of category names in the same order as `batch`.
 * Uses the smart key pool (rotation across healthy keys, throttled keys get
 * cooldowns, garbage responses regenerate on another key).
 */
async function groqClassifyBatch(batch, apiKey) {
  const productLines = batch
    .map((p, i) => {
      const name = (p.name || "").trim();
      const desc = (p.description || "").trim().substring(0, 500);
      return `${i + 1}. NAME: ${name}\n   DESCRIPTION: ${desc || "(no description)"}`;
    })
    .join("\n\n");

  const userPrompt =
    `Classify the following ${batch.length} products. ` +
    `Reply with ONLY a valid JSON array of exactly ${batch.length} category strings in the same order.\n` +
    `Example for 3 products: ["Electronics","Fashion","Home"]\n\n` +
    productLines;

  const params = {
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: GROQ_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    max_tokens: batch.length * 12 + 30,
  };

  const parse = (raw) => {
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) throw new Error(`Non-JSON response: ${raw.substring(0, 120)}`);
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || parsed.length !== batch.length) {
      throw new Error(`Got ${parsed.length} results for ${batch.length} products`);
    }
    return parsed.map((cat) =>
      VALID_CATEGORIES.includes(cat) ? cat : "Uncategorized"
    );
  };

  if (apiKey) {
    // Legacy single-key path (kept for callers that pass a key explicitly)
    const groq = new Groq({ apiKey });
    for (let attempt = 0; attempt <= 5; attempt++) {
      try {
        const chat = await groq.chat.completions.create(params);
        return parse((chat.choices[0]?.message?.content || "").trim());
      } catch (err) {
        const isRateLimit =
          err?.status === 429 ||
          err?.error?.type === "rate_limit_exceeded" ||
          (err?.message || "").toLowerCase().includes("rate limit");
        if (isRateLimit && attempt < 5) {
          await sleep(Math.pow(2, attempt) * 2000);
          continue;
        }
        throw err;
      }
    }
  }

  return groqKeyPool.chatWithRetry("categories", params, {
    parse,
    budget: 300_000,
    split: (p) => groqKeyPool.splitBatchParams(p, batch, (sub) => {
      const lines = sub
        .map((x, i) => {
          const name = (x.name || "").trim();
          const desc = (x.description || "").trim().substring(0, 500);
          return `${i + 1}. NAME: ${name}\n   DESCRIPTION: ${desc || "(no description)"}`;
        })
        .join("\n\n");
      return (
        `Classify the following ${sub.length} products. ` +
        `Reply with ONLY a valid JSON array of exactly ${sub.length} category strings in the same order.\n` +
        `Example for 3 products: ["Electronics","Fashion","Home"]\n\n` +
        lines
      );
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Recategorize in-memory state — polled by /recategorize-status
// ─────────────────────────────────────────────────────────────────────────────
const recategorizeState = {
  running: false,
  processed: 0,
  total: 0,
  updated: 0,
  unchanged: 0,
  done: false,
  error: null,
  logs: [],
};

function resetRecategorizeState() {
  recategorizeState.running = false;
  recategorizeState.processed = 0;
  recategorizeState.total = 0;
  recategorizeState.updated = 0;
  recategorizeState.unchanged = 0;
  recategorizeState.done = false;
  recategorizeState.error = null;
  recategorizeState.logs = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared Groq pipeline: AI re-categorization + SEO copy optimization.
// Used by POST /recategorize-all.
// addLog(type, message, extra) streams progress; isAborted() is polled
// between batches so a stop halts this phase.
// ─────────────────────────────────────────────────────────────────────────────
async function runRecategorizeAndOptimize({ addLog, io, isAborted }) {
  // 1. Ensure category documents exist
  addLog("info", "Ensuring categories exist in database…");
  for (const cat of CATEGORIES) {
    await Category.findOneAndUpdate(
      { slug: cat.slug },
      { $setOnInsert: { name: cat.name, slug: cat.slug } },
      { upsert: true, new: true }
    );
  }

  // 2. Load every product into memory (name + description + current category)
  addLog("info", "Loading all products…");
  const allProducts = await Product.find({})
    .select("_id name description category")
    .lean();

  const total = allProducts.length;
  recategorizeState.total = total;
  addLog(
    "info",
    `Loaded ${total} products. Classifying with Groq AI (${GROQ_MODEL}), batch size ${GROQ_BATCH_SIZE}…`,
    { total }
  );

  // 3. Build batches — big-first wave drains every key's empty token window
  //    in one call, then normal-sized batches flow at per-key wall speed.
  const concurrency = Math.max(4, Math.min(32, await groqKeyPool.healthyCount()));
  const batches = [];
  {
    const BIG = 24; // copy-optimize ≈ 300 tok/product; 24 × 300 < 8k output cap
    let i = 0;
    for (; i < allProducts.length && batches.length < concurrency; i += BIG) {
      batches.push(allProducts.slice(i, i + BIG));
    }
    for (; i < allProducts.length; i += GROQ_BATCH_SIZE) {
      batches.push(allProducts.slice(i, i + GROQ_BATCH_SIZE));
    }
  }

  let processed = 0;
  let updated   = 0;
  let unchanged = 0;

  // 4. Process with concurrency limit
  for (let i = 0; i < batches.length; i += concurrency) {
    if (isAborted && isAborted()) break;
    const chunk = batches.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (batch) => {
        let categories;
        try {
          categories = await groqClassifyBatch(batch);
        } catch (err) {
          addLog(
            "warn",
            `Batch failed (${(err.message || "").substring(0, 80)}) — falling back to keyword classifier for ${batch.length} products.`
          );
          categories = batch.map((p) => categorizeProduct(p.name, p.description));
        }

        const optimizedBatch = await optimizeProductCopy(batch, undefined);

        // Bulk-write only the changed products
        const bulkOps = [];
        for (let j = 0; j < batch.length; j++) {
          const p      = batch[j];
          const newCat = categories[j];
          const newName = optimizedBatch[j]?.name || p.name || "";
          const newDescription = optimizedBatch[j]?.description || p.description || "";
          if (newName !== p.name || newCat !== p.category || newDescription !== p.description) {
            bulkOps.push({
              updateOne: {
                filter: { _id: p._id },
                update: {
                  $set: {
                    name: newName,
                    slug: slugify(newName) || p.slug,
                    category: newCat,
                    description: newDescription,
                  },
                },
              },
            });
            updated++;
          } else {
            unchanged++;
          }
          processed++;
        }
        if (bulkOps.length) await Product.bulkWrite(bulkOps);

        recategorizeState.processed = processed;
        recategorizeState.updated   = updated;
        recategorizeState.unchanged = unchanged;

        const pct = Math.round((processed / total) * 100);
        addLog(
          "progress",
          `${processed} / ${total} — ${updated} reassigned/optimized (${pct}%)`,
          { processed, total, updated, unchanged, pct }
        );
      })
    );
  }

  // 5. Refresh category counts
  addLog("info", "Updating category product counts…");
  for (const cat of CATEGORIES) {
    const count = await Product.countDocuments({ category: cat.name });
    await Category.updateOne({ slug: cat.slug }, { $set: { productCount: count } });
  }

  if (io) io.emit("products_updated", { source: "recategorize", updated });

  return { updated, unchanged, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/products/recategorize-keywords  (admin only)
// Re-categorizes all products using keyword-based classifier (no Groq needed).
// Fast, no API keys required. Use this to fix existing products.
// ─────────────────────────────────────────────────────────────────────────────
const recategorizeAllKeywords = async (req, res) => {
  invalidateProductListCache();
  
  const addLog = (type, message, extra = {}) => {
    console.log(`[keywords-recat] ${type}: ${message}`, extra);
  };

  try {
    addLog("info", "Starting keyword-based re-categorization…");
    
    const allProducts = await Product.find({}).select("_id name description category").lean();
    const total = allProducts.length;
    addLog("info", `Loaded ${total} products`);

    let updated = 0;
    let unchanged = 0;
    const bulkOps = [];

    for (const p of allProducts) {
      const newCat = categorizeProduct(p.name || "", p.description || "");
      if (newCat !== p.category) {
        bulkOps.push({
          updateOne: {
            filter: { _id: p._id },
            update: { $set: { category: newCat } },
          },
        });
        updated++;
      } else {
        unchanged++;
      }
    }

    if (bulkOps.length > 0) {
      await Product.bulkWrite(bulkOps);
      addLog("info", `Bulk updated ${bulkOps.length} products`);
    }

    // Ensure category documents exist
    for (const cat of CATEGORIES) {
      await Category.findOneAndUpdate(
        { slug: cat.slug },
        { $setOnInsert: { name: cat.name, slug: cat.slug } },
        { upsert: true, new: true }
      );
    }

    return res.status(200).json({
      success: true,
      message: `Re-categorization complete. ${updated} updated, ${unchanged} unchanged.`,
      updated,
      unchanged,
      total,
    });
  } catch (err) {
    console.error("recategorizeAllKeywords error:", err);
    return res.status(500).json({ success: false, message: "Re-categorization failed: " + err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/products/recategorize-all  (admin only)
// Responds immediately then runs in the background.
// Poll /recategorize-status for live progress.
// ─────────────────────────────────────────────────────────────────────────────
const recategorizeAll = async (req, res) => {
  invalidateProductListCache();
  if (recategorizeState.running) {
    return res
      .status(409)
      .json({ success: false, message: "Re-categorization already in progress." });
  }

  const groqAvailable = await groqKeyPool.hasKeys();
  if (!groqAvailable) {
    return res
      .status(500)
      .json({ success: false, message: "No Groq API keys configured. Set them in Admin → Settings." });
  }

  resetRecategorizeState();
  recategorizeState.running = true;

  const io = req.app.get("io");
  const addLog = (type, message, extra = {}) => {
    const entry = { type, message, time: new Date().toLocaleTimeString(), ...extra };
    recategorizeState.logs.push(entry);
    if (recategorizeState.logs.length > 500) recategorizeState.logs.shift();
    if (io) io.emit("recategorize_progress", entry);
    return entry;
  };

  // Respond immediately — heavy processing runs in background
  res.json({ success: true, message: "AI re-categorization started." });

  (async () => {
    try {
      const { updated, unchanged, total } = await runRecategorizeAndOptimize({
        addLog,
        io,
      });

      recategorizeState.running = false;
      recategorizeState.done    = true;
      addLog(
        "done",
        `All done! ${updated} products reassigned/optimized, ${unchanged} already correct.`,
        { updated, unchanged, total }
      );
    } catch (err) {
      recategorizeState.running = false;
      recategorizeState.error   = err.message;
      addLog("error", `Fatal error: ${err.message}`);
      console.error("recategorizeAll error:", err);
    }
  })();
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products/recategorize-status  (admin only)
// ─────────────────────────────────────────────────────────────────────────────
const getRecategorizeStatus = (req, res) => {
  return res.json({ success: true, ...recategorizeState });
};

const getFeaturedLanding = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 8, 200);
    const listKey = req.originalUrl;
    const cached = getCachedList(listKey);
    if (cached) {
      return listCacheControl(res).status(200).json(cached);
    }
    // Admin-set order first: featuredOrder ascending with null/missing last,
    // tiebroken by updatedAt desc. The $ifNull maps missing orders to the
    // largest number so they sort last — and lets the $limit run in Mongo.
    const products = await Product.aggregate([
      { $match: { featuredOnLanding: true, hidden: { $ne: true } } },
      {
        $project: {
          ...LIST_PROJECTION,
          _sortOrder: { $ifNull: ["$featuredOrder", Number.MAX_SAFE_INTEGER] },
        },
      },
      { $sort: { _sortOrder: 1, updatedAt: -1 } },
      { $limit: limit },
    ]);
    const safeProducts = products.map(toCustomerProduct);
    const payload = { success: true, products: safeProducts };
    setCachedList(listKey, payload);
    return listCacheControl(res).status(200).json(payload);
  } catch (err) {
    console.error("getFeaturedLanding error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch featured products." });
  }
};

const toggleFeaturedLanding = async (req, res) => {
  invalidateProductListCache();
  try {
    const { featured } = req.body;
    if (typeof featured !== "boolean") {
      return res.status(400).json({ success: false, message: "featured must be a boolean." });
    }
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { featuredOnLanding: featured },
      { new: true }
    );
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }
    const count = await Product.countDocuments({ featuredOnLanding: true });
    return res.status(200).json({ success: true, product, count });
  } catch (err) {
    console.error("toggleFeaturedLanding error:", err);
    return res.status(500).json({ success: false, message: "Failed to toggle featured status." });
  }
};

const getFeaturedCount = async (req, res) => {
  try {
    const count = await Product.countDocuments({ featuredOnLanding: true });
    return res.status(200).json({ success: true, count });
  } catch (err) {
    console.error("getFeaturedCount error:", err);
    return res.status(500).json({ success: false, message: "Failed to get featured count." });
  }
};

const setFeaturedOrder = async (req, res) => {
  invalidateProductListCache();
  const order = req.body?.order;
  if (!Array.isArray(order)) {
    return res.status(400).json({ success: false, message: "order must be an array of product ids" });
  }
  if (order.length > 500) {
    return res.status(400).json({ success: false, message: "order too large" });
  }
  for (const id of order) {
    if (typeof id !== "string" || !/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ success: false, message: `invalid product id: ${id}` });
    }
  }
  // The passed array is the COMPLETE ordering: unlisted featured products lose
  // their order (they still stay featured, but sort after the ordered ones).
  const ops = [
    { updateMany: { filter: { featuredOnLanding: true }, update: { $set: { featuredOrder: null } } } },
  ];
  order.forEach((id, i) => {
    ops.push({ updateOne: { filter: { _id: id }, update: { $set: { featuredOrder: i + 1, featuredOnLanding: true } } } });
  });
  await Product.bulkWrite(ops);
  return res.json({ success: true, count: order.length });
};

// ── Update single product manual position ─────────────────────────────────
const updateProductManualPosition = async (req, res) => {
  try {
    const { productId } = req.params;
    const { position } = req.body;

    if (typeof position !== 'number' || position < 0) {
      return res.status(400).json({ success: false, message: 'Position must be a non-negative number' });
    }

    const product = await Product.findByIdAndUpdate(
      productId,
      { manualPosition: position },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    return res.json({ success: true, product });
  } catch (err) {
    console.error('Error updating manual position:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── Bulk update multiple products manual positions ─────────────────────────
const updateBulkManualPositions = async (req, res) => {
  try {
    const { updates } = req.body; // Array of { productId, position }

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ success: false, message: 'Updates array is required' });
    }

    const ops = updates.map(({ productId, position }) => ({
      updateOne: {
        filter: { _id: productId },
        update: { $set: { manualPosition: position } }
      }
    }));

    const result = await Product.bulkWrite(ops);
    return res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error('Error updating bulk manual positions:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── Clear all manual positions (reset to default ordering) ───────────────────
const clearAllManualPositions = async (req, res) => {
  try {
    const result = await Product.updateMany(
      {},
      { $unset: { manualPosition: "" } }
    );

    return res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (err) {
    console.error('Error clearing manual positions:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  invalidateProductListCache,
  buildGallery,
  nextProductId,
  createManualProduct,
  getProducts,
  getSuggestions,
  getTrendingSearches,
  getLeaderboard,
  getReport,
  getStats,
  clearProducts,
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
  getAdminProducts,
  recategorizeAll,
  recategorizeAllKeywords,
  getRecategorizeStatus,
  runRecategorizeAndOptimize,
  recategorizeState,
  getFeaturedLanding,
  toggleFeaturedLanding,
  getFeaturedCount,
  setFeaturedOrder,
  productAvailability,
  updateProductManualPosition,
  updateBulkManualPositions,
  clearAllManualPositions,
  // Shared with the seller product endpoints so seller listings get the same
  // slug treatment as catalogue products.
  slugify,
  uniqueSlug,
};

