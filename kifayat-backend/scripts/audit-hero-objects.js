// Audit (and optionally repair) the landing-page hero product ids.
//
// Settings.heroObjects holds two product ids picked by an admin. If the chosen
// product is later deleted or hidden, the storefront keeps requesting it and the
// homepage logs a 404 for every visitor. The API now refuses to SAVE a dangling
// id and returns null for one that went stale, but an already-broken value still
// needs repairing once.
//
// Usage
//   node scripts/audit-hero-objects.js          report only
//   node scripts/audit-hero-objects.js --fix    repoint broken slots at live products
require("dotenv").config();
const mongoose = require("mongoose");
const Settings = require("../models/Settings");
const Product = require("../models/Product");
const { resolveHeroProduct } = require("../utils/heroObjects");

/** Live, storefront-visible products, best-first. */
async function candidateProducts() {
  return Product.find({
    inStock: true,
    hidden: { $ne: true },
    deleted: { $ne: true },
    imageUrl: { $nin: ["", null] },
  })
    .select("_id name productId slug category salesCount")
    .sort({ salesCount: -1, createdAt: -1 })
    .lean();
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not set — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const fix = process.argv.includes("--fix");
  const settings = await Settings.findOne({}).lean();
  const hero = settings?.heroObjects || {};
  console.log(`Current heroObjects: left=${hero.left ?? "(empty)"} right=${hero.right ?? "(empty)"}`);

  const status = { left: null, right: null };
  const broken = [];
  for (const slot of ["left", "right"]) {
    const value = hero[slot];
    if (!value) {
      console.log(`  ${slot}: (empty)`);
      continue;
    }
    const resolved = await resolveHeroProduct(value);
    if (resolved.ok) {
      status[slot] = String(resolved.product._id);
      console.log(`  ${slot}: OK -> ${resolved.product.name} (${resolved.product.productId})`);
    } else {
      console.log(`  ${slot}: BROKEN (${resolved.reason}) — id ${value} does not resolve to a live product`);
      broken.push(slot);
    }
  }

  if (broken.length === 0) {
    console.log("Hero objects are healthy — nothing to do.");
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!fix) {
    console.log(`\n${broken.length} broken slot(s): ${broken.join(", ")}. Re-run with --fix to repoint them.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const candidates = await candidateProducts();
  if (candidates.length === 0) {
    console.error("No live products with images to point the hero at — nothing changed.");
    await mongoose.disconnect();
    process.exit(1);
  }

  const next = { ...status };
  const used = new Set(Object.values(next).filter(Boolean));
  for (const slot of broken) {
    const pick = candidates.find((c) => !used.has(String(c._id)));
    if (!pick) break;
    next[slot] = String(pick._id);
    used.add(String(pick._id));
    console.log(`  ${slot}: repointed to ${pick.name} (${pick.productId})`);
  }

  await Settings.findOneAndUpdate(
    {},
    { $set: { heroObjects: next } },
    { upsert: true, returnDocument: "after" },
  );
  console.log(`\nheroObjects updated: left=${next.left ?? "(empty)"} right=${next.right ?? "(empty)"}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Hero audit failed:", err.message);
  process.exit(1);
});
