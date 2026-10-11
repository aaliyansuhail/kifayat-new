/**
 * End-to-end check for seller click/hover/view analytics.
 * Run: node verify-interaction-analytics.js   (from kifayat-backend/scripts)
 *
 * The local catalogue can be empty, so the script seeds a throwaway
 * seller-owned product when needed and removes it again at the end.
 */
const BASE = process.env.BASE || "http://localhost:3001";
require("dotenv").config();
const SEED = require("../models/Product");
const connectDB = require("../config/db");
const mongoose = require("mongoose");

async function json(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, setCookie: res.headers.get("set-cookie") };
}

(async () => {
  await connectDB();

  // 1. Seller login → session cookie
  const login = await json(`${BASE}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({
      email: process.env.SELLER_EMAIL || "faiza@kifayat.co",
      password: process.env.SELLER_PASSWORD || "faiza1234@kifayat.co",
    }),
  });
  console.log("login:", login.status, login.body?.success, login.body?.user?.role);
  const cookie = (login.setCookie || "").split(";")[0];
  if (!cookie) {
    console.error("no session cookie:", login.body);
    process.exit(1);
  }
  const auth = { Cookie: cookie };

  // 2. Find (or seed) a seller-owned product
  const email = process.env.SELLER_EMAIL || "faiza@kifayat.co";
  const list = await json(
    `${BASE}/api/products?seller=${encodeURIComponent(email)}&limit=5`
  );
  let product = list.body?.products?.[0];
  let seeded = false;
  if (!product) {
    seeded = true;
    product = await SEED.create({
      name: "[e2e] Analytics probe product",
      slug: "e2e-analytics-probe-product",
      salePrice: 1999,
      stock: 5,
      category: "Electronics",
      sellerId: login.body.user._id,
      imageUrl: "",
    });
    console.log("seeded throwaway product:", product._id);
  }
  console.log("products found:", list.body?.total, "→", product._id, product.name);
  console.log("sellerId on product:", product.sellerId);

  // 3. Baseline analytics
  const before = await json(`${BASE}/api/seller/analytics/interactions?days=30`, {
    headers: auth,
  });
  const b = before.body.interactions;
  console.log("\nBEFORE", { views: b.totals.views, hovers: b.totals.hovers, clicks: b.totals.clicks, visitors: b.totals.uniqueVisitors });

  // 4. Simulate three anonymous customers interacting with that product
  const run = Date.now().toString(36);
  const visitorA = `e2e-a-${run}`;
  const visitorB = `e2e-b-${run}`;
  const send = (type, visitor) =>
    json(`${BASE}/api/interactions/track`, {
      method: "POST",
      body: JSON.stringify({
        productId: product._id,
        type,
        sessionId: visitor,
        metadata: { scope: "e2e-test" },
      }),
    });

  await send("view", visitorA);
  await send("hover", visitorA);
  await send("click", visitorA);
  await send("view", visitorB);
  await send("hover", visitorB);
  await send("click", visitorB);
  await send("pageview", visitorB);

  // Validation: bad product id and bad type are rejected
  const bad = await json(`${BASE}/api/interactions/track`, {
    method: "POST",
    body: JSON.stringify({ productId: "nope", type: "click" }),
  });
  const badType = await json(`${BASE}/api/interactions/track`, {
    method: "POST",
    body: JSON.stringify({ productId: product._id, type: "purchase" }),
  });
  console.log("\nvalidation → bad productId:", bad.status, bad.body?.message);
  console.log("validation → bad type:", badType.status, badType.body?.message);

  // 5. Analytics after
  const after = await json(`${BASE}/api/seller/analytics/interactions?days=30`, {
    headers: auth,
  });
  const a = after.body.interactions;
  console.log("\nAFTER", { views: a.totals.views, hovers: a.totals.hovers, clicks: a.totals.clicks, pageviews: a.totals.pageviews, visitors: a.totals.uniqueVisitors });
  console.log("derived:", {
    ctr: a.totals.clickThroughRate,
    clicksPerVisitor: a.totals.clicksPerVisitor,
    clickToPageRate: a.totals.clickToPageRate,
  });
  console.log("timeline points:", a.timeline.length, "last:", a.timeline.at(-1));
  const row = a.products.find((p) => p.productId === String(product._id));
  console.log("per-product row:", row);
  console.log("products returned:", a.products.length);
  console.log("devices:", a.devices, "recent:", a.recent.length);

  // 6. The legacy analytics payload also carries the 30-day summary
  const legacy = await json(`${BASE}/api/seller/analytics`, { headers: auth });
  console.log("legacy interactions:", legacy.body.analytics.interactions);

  const todayBefore = b.timeline.at(-1);
  const todayAfter = a.timeline.at(-1);
  const rowDelta = row && b.products.find((p) => p.productId === String(product._id));
  const ok =
    a.totals.clicks === b.totals.clicks + 2 &&
    a.totals.hovers === b.totals.hovers + 2 &&
    a.totals.views === b.totals.views + 2 &&
    a.totals.pageviews === b.totals.pageviews + 1 &&
    a.totals.uniqueVisitors >= b.totals.uniqueVisitors + 2 &&
    Boolean(row && row.clicks === (rowDelta?.clicks ?? 0) + 2) &&
    todayAfter.clicks === todayBefore.clicks + 2 &&
    todayAfter.hovers === todayBefore.hovers + 2 &&
    todayAfter.pageviews === todayBefore.pageviews + 1;

  if (seeded) {
    await SEED.deleteOne({ _id: product._id });
    console.log("cleaned up throwaway product");
  }
  // Synthetic traffic never lingers in a seller's real analytics.
  const Interaction = require("../models/ProductInteraction");
  const purged = await Interaction.deleteMany({ sessionId: /e2e-(visitor-)?[ab]/ });
  console.log(`purged ${purged.deletedCount} synthetic interaction(s)`);
  await mongoose.disconnect();

  console.log(`\n${ok ? "PASS" : "FAIL"} — deltas match simulated traffic`);
  process.exit(ok ? 0 : 1);
})();
