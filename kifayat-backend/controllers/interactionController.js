const mongoose = require("mongoose");
const Product = require("../models/Product");
const ProductInteraction = require("../models/ProductInteraction");

const TRACKABLE_TYPES = new Set(["click", "hover", "view", "pageview"]);

const isObjectId = (value) =>
  typeof value === "string" && mongoose.Types.ObjectId.isValid(value);

const clientKey = (req) =>
  (req.body && req.body.sessionId) ||
  req.get("x-visitor-id") ||
  req.cookies?.visitorId ||
  null;

// Public, unauthenticated tracking endpoint. Storefront visitors never log in,
// so this must never require a session — optionalAuth only fills req.user when a
// valid cookie happens to be present.
const trackInteraction = async (req, res) => {
  try {
    const { productId, type, metadata } = req.body || {};

    if (!isObjectId(productId)) {
      return res.status(400).json({
        success: false,
        message: "A valid productId is required.",
      });
    }

    if (!TRACKABLE_TYPES.has(type)) {
      return res.status(400).json({
        success: false,
        message: `type must be one of: ${[...TRACKABLE_TYPES].join(", ")}.`,
      });
    }

    // Only products that actually belong to a seller produce seller analytics.
    // Imported catalogue rows predate the soft-delete field, so match "not
    // deleted" rather than deleted === false.
    const product = await Product.findOne(
      { _id: productId, deleted: { $ne: true } },
      { sellerId: 1 }
    );

    if (!product || !product.sellerId) {
      return res.status(202).json({ success: true, tracked: false });
    }

    await ProductInteraction.create({
      productId: product._id,
      sellerId: product.sellerId,
      interactionType: type,
      userId: req.user?._id || null,
      sessionId: clientKey(req),
      ipAddress: req.ip || null,
      userAgent: (req.get("user-agent") || "").slice(0, 300) || null,
      referrer: (req.get("referer") || "").slice(0, 500) || null,
      metadata:
        metadata && typeof metadata === "object" && !Array.isArray(metadata)
          ? metadata
          : {},
    });

    res.status(201).json({ success: true, tracked: true });
  } catch (err) {
    console.error("Track interaction error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to record interaction.",
    });
  }
};

// Day buckets are cut in UTC because the timeline labels come from Mongo's
// $dateToString, which is UTC. Using local midnight here would leave today's
// events sitting in a bucket that is one day ahead of the series.
const dayStart = (days) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d;
};

const countVisitors = (rows) => {
  const ids = new Set();
  rows.forEach((r) => {
    if (r.sessionId) ids.add(r.sessionId);
    if (r.userId) ids.add(`u:${r.userId}`);
  });
  return ids.size;
};

const deviceFromUserAgent = (ua = "") => {
  const s = ua.toLowerCase();
  if (/ipad|tablet|kindle|playbook|silk/.test(s)) return "Tablet";
  if (/mobi|iphone|ipod|android.*mobile|windows phone/.test(s)) return "Mobile";
  if (!ua) return "Unknown";
  return "Desktop";
};

// A "customer" is one person, not one browser tab: every event from a signed-in
// shopper collapses onto their account id, so browsing while logged in counts
// once instead of once per session.
const VISITOR_ID = {
  $concat: [
    { $cond: [{ $eq: [{ $type: "$userId" }, "objectId"] }, "u:", "s:"] },
    {
      $ifNull: [
        { $toString: "$userId" },
        { $ifNull: [{ $toString: "$sessionId" }, "anonymous"] },
      ],
    },
  ],
};

// Seller-facing analytics: who touched my products, how often, and how it moves.
const getInteractionAnalytics = async (req, res) => {
  try {
    const sellerId = req.user._id;
    const days = Math.min(
      Math.max(parseInt(req.query.days, 10) || 30, 1),
      365
    );
    const since = dayStart(days);

    const [
      totalsAgg,
      prevTotalsAgg,
      uniqueAgg,
      byProduct,
      byDay,
      byType,
      byDevice,
      topReferrers,
      recent,
    ] = await Promise.all([
        ProductInteraction.aggregate([
          { $match: { sellerId, createdAt: { $gte: since } } },
          {
            $group: {
              _id: "$interactionType",
              count: { $sum: 1 },
              visitors: { $addToSet: VISITOR_ID },
            },
          },
        ]),
        // Previous window of the same length → period-over-period deltas.
        ProductInteraction.aggregate([
          {
            $match: {
              sellerId,
              createdAt: {
                $gte: new Date(since.getTime() - days * 86_400_000),
                $lt: since,
              },
            },
          },
          { $group: { _id: "$interactionType", count: { $sum: 1 } } },
        ]),
        // Unique visitors across ALL types — a set union, not a sum of per-type
        // visitors, because one visitor usually both hovers and clicks.
        ProductInteraction.aggregate([
          { $match: { sellerId, createdAt: { $gte: since } } },
          {
            $group: {
              _id: null,
              visitors: { $addToSet: VISITOR_ID },
            },
          },
        ]),
        ProductInteraction.aggregate([
          { $match: { sellerId, createdAt: { $gte: since } } },
          {
            $group: {
              _id: "$productId",
              views: {
                $sum: { $cond: [{ $eq: ["$interactionType", "view"] }, 1, 0] },
              },
              clicks: {
                $sum: { $cond: [{ $eq: ["$interactionType", "click"] }, 1, 0] },
              },
              hovers: {
                $sum: { $cond: [{ $eq: ["$interactionType", "hover"] }, 1, 0] },
              },
              pageviews: {
                $sum: { $cond: [{ $eq: ["$interactionType", "pageview"] }, 1, 0] },
              },
              visitors: { $addToSet: VISITOR_ID },
            },
          },
          { $sort: { clicks: -1, hovers: -1, views: -1 } },
          { $limit: 50 },
          {
            $lookup: {
              from: "products",
              localField: "_id",
              foreignField: "_id",
              as: "product",
            },
          },
          { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              productId: "$_id",
              name: { $ifNull: ["$product.name", "Deleted product"] },
              image: "$product.imageUrl",
              salePrice: "$product.salePrice",
              stock: "$product.stock",
              views: 1,
              clicks: 1,
              hovers: 1,
              pageviews: 1,
              visitors: 1,
            },
          },
        ]),
        ProductInteraction.aggregate([
          { $match: { sellerId, createdAt: { $gte: since } } },
          {
            $group: {
              _id: {
                day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                type: "$interactionType",
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { "_id.day": 1 } },
        ]),
        ProductInteraction.aggregate([
          { $match: { sellerId, createdAt: { $gte: since } } },
          { $group: { _id: "$interactionType", count: { $sum: 1 } } },
        ]),
        ProductInteraction.aggregate([
          {
            $match: {
              sellerId,
              createdAt: { $gte: since },
              userAgent: { $nin: [null, ""] },
            },
          },
          { $group: { _id: "$userAgent", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 500 },
        ]),
        ProductInteraction.aggregate([
          { $match: { sellerId, referrer: { $nin: [null, ""] } } },
          { $group: { _id: "$referrer", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 8 },
        ]),
        ProductInteraction.find({ sellerId })
          .sort({ createdAt: -1 })
          .limit(25)
          .populate("productId", "name imageUrl")
          .lean(),
      ]);

    const prev = Object.fromEntries(
      prevTotalsAgg.map((r) => [r._id, r.count])
    );

    const perType = {};
    totalsAgg.forEach((row) => {
      perType[row._id] = {
        events: row.count,
        visitors: row.visitors.length,
        previous: prev[row._id] || 0,
      };
    });

    // Unique visitors across all types, de-duplicated (a set union, not a sum).
    const uniqueVisitors = uniqueAgg[0]?.visitors?.length || 0;

    // Dense daily series so the chart has no gaps.
    const BUCKET_KEY = {
      view: "views",
      hover: "hovers",
      click: "clicks",
      pageview: "pageviews",
    };
    const dailyMap = new Map();
    for (let i = 0; i < days; i += 1) {
      const d = new Date(since.getTime() + i * 86_400_000);
      dailyMap.set(d.toISOString().slice(0, 10), {
        views: 0,
        clicks: 0,
        hovers: 0,
        pageviews: 0,
      });
    }
    byDay.forEach((row) => {
      const bucket = dailyMap.get(row._id.day);
      const key = BUCKET_KEY[row._id.type];
      if (bucket && key) bucket[key] = row.count;
    });    const timeline = [...dailyMap.entries()].map(([date, v]) => ({ date, ...v }));

    const devices = new Map();
    byDevice.forEach((row) => {
      const device = deviceFromUserAgent(row._id);
      devices.set(device, (devices.get(device) || 0) + row.count);
    });

    const totalEvents = byType.reduce((s, r) => s + r.count, 0);
    const views = perType.view?.events || 0;
    const clicks = perType.click?.events || 0;
    const hovers = perType.hover?.events || 0;
    const pageviews = perType.pageview?.events || 0;

    res.status(200).json({
      success: true,
      interactions: {
        range: { days, since },
        totals: {
          views,
          clicks,
          hovers,
          pageviews,
          events: totalEvents,
          uniqueVisitors,
          // Share of viewers that clicked through to the product page.
          clickThroughRate: views ? +(clicks / views).toFixed(4) : 0,
          // Clicks per unique visitor — "how many customers clicked" per head.
          clicksPerVisitor: uniqueVisitors ? +(clicks / uniqueVisitors).toFixed(2) : 0,
          hoversPerVisitor: uniqueVisitors ? +(hovers / uniqueVisitors).toFixed(2) : 0,
          hoverToClickRate: hovers ? +(clicks / hovers).toFixed(4) : 0,
          // Of the people who clicked, how many actually opened the product page.
          clickToPageRate: clicks ? +(pageviews / clicks).toFixed(4) : 0,
        },
        previousTotals: {
          views: prev.view || 0,
          clicks: prev.click || 0,
          hovers: prev.hover || 0,
          pageviews: prev.pageview || 0,
        },
        timeline,
        byType: Object.entries(perType).map(([type, v]) => ({ type, ...v })),
        devices: [...devices.entries()]
          .map(([device, count]) => ({
            device,
            count,
            share: totalEvents ? +(count / totalEvents).toFixed(4) : 0,
          }))
          .sort((a, b) => b.count - a.count),
        referrers: topReferrers.map((r) => ({ referrer: r._id, count: r.count })),
        products: byProduct.map((p) => ({
          productId: p.productId,
          name: p.name,
          image: p.image,
          salePrice: p.salePrice,
          stock: p.stock,
          views: p.views || 0,
          clicks: p.clicks || 0,
          hovers: p.hovers || 0,
          pageviews: p.pageviews || 0,
          visitors: (p.visitors || []).length,
          ctr: p.views ? +((p.clicks || 0) / p.views).toFixed(4) : 0,
          hoverToClick: p.hovers ? +((p.clicks || 0) / p.hovers).toFixed(4) : 0,
        })),
        recent: recent.map((i) => ({
          _id: i._id,
          type: i.interactionType,
          createdAt: i.createdAt,
          productName: i.productId?.name || null,
          productImage: i.productId?.imageUrl || null,
          userAgent: i.userAgent,
          referrer: i.referrer,
        })),
      },
    });
  } catch (err) {
    console.error("Get interaction analytics error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch interaction analytics.",
    });
  }
};

module.exports = { trackInteraction, getInteractionAnalytics };
