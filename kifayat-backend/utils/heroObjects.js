// ─── Landing hero diptych ("Objects Considered") helpers ────────────────────
//
// The landing page stores two product ids in Settings.heroObjects and the
// storefront fetches each one. Those ids are chosen by an admin and can go
// stale the moment the product is deleted or hidden — which used to surface as
// a 404 request on the homepage for every visitor.
//
// Two guarantees live here:
//   • on WRITE, an id must resolve to a live product (so a dangling id cannot
//     be saved in the first place)
//   • on READ, an id that no longer resolves is reported as null, so the
//     storefront falls back to its curated selection instead of 404-ing
const Product = require("../models/Product");

/** A product is usable for the hero when it exists, is not hidden and not deleted. */
function isLiveProduct(product) {
  return !!product && product.hidden !== true && product.deleted !== true;
}

/**
 * Resolve an admin-supplied hero id to a live product.
 * Accepts the Mongo `_id`, the public `productId` (kp-00000000001) or the slug,
 * because the admin UI has used each of those shapes over time.
 *
 * @param {string|null|undefined} value
 * @returns {Promise<{ok: true, product: object} | {ok: false, reason: string}>}
 */
async function resolveHeroProduct(value) {
  const key = String(value ?? "").trim();
  if (!key) return { ok: false, reason: "empty" };

  const select = "_id name productId slug hidden deleted";
  const queries = [
    { productId: key },
    { slug: key },
  ];
  // Only use findById for a well-formed ObjectId, otherwise Mongoose throws a
  // cast error for arbitrary strings.
  if (/^[0-9a-fA-F]{24}$/.test(key)) {
    const byId = await Product.findById(key).select(select).lean();
    if (isLiveProduct(byId)) return { ok: true, product: byId };
  }

  for (const query of queries) {
    const found = await Product.findOne(query).select(select).lean();
    if (isLiveProduct(found)) return { ok: true, product: found };
  }

  const anyShape = await Product.findOne({
    $or: [{ productId: key }, { slug: key }],
  })
    .select(select)
    .lean();

  return { ok: false, reason: anyShape ? "not_live" : "not_found" };
}

/**
 * Normalize a stored hero pair for the storefront: each side becomes the live
 * product's `_id`, or null when it can no longer be resolved. Never throws.
 *
 * @param {{left?: string|null, right?: string|null}} heroObjects
 */
async function resolveHeroObjectsForStorefront(heroObjects = {}) {
  const out = { left: null, right: null };
  for (const slot of ["left", "right"]) {
    const value = heroObjects?.[slot];
    if (!value) continue;
    try {
      const resolved = await resolveHeroProduct(value);
      out[slot] = resolved.ok ? String(resolved.product._id) : null;
    } catch {
      out[slot] = null;
    }
  }
  return out;
}

module.exports = { resolveHeroProduct, resolveHeroObjectsForStorefront, isLiveProduct };
