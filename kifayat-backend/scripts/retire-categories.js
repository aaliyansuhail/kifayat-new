#!/usr/bin/env node
/**
 * Retire the Beauty / Sports / Toys / Home & Kitchen / Women categories and
 * introduce the new "Home" category.
 *
 * Storefront taxonomy becomes: Electronics · Fashion · Home
 *
 * Products that lived in a retired category are re-filed into the surviving
 * category that now carries those goods, so nothing is orphaned. Existing
 * category documents and the re-filed products are backed up to
 * backups/category-retire-<timestamp>.json before anything is written.
 *
 * Usage
 *   node scripts/retire-categories.js           # dry run — prints the plan
 *   node scripts/retire-categories.js --apply   # write the changes
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

// ── Target taxonomy ────────────────────────────────────────────────────────
const KEEP = ["Electronics", "Fashion", "Home"];
const NEW_CATEGORY = "Home";

// Retired category (by name and by slug) → surviving category name.
const RETIRED = {
  beauty: "Fashion",
  "Beauty": "Fashion",
  sports: "Home",
  "Sports": "Home",
  toys: "Home",
  "Toys": "Home",
  "home-kitchen": "Home",
  "Home & Kitchen": "Home",
  women: "Fashion",
  "Women": "Fashion",
};

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const Category = require("../models/Category");
  const Product = require("../models/Product");

  const dbName = mongoose.connection.name;
  console.log(`Connected to database "${dbName}"`);
  console.log(APPLY ? "Mode: APPLY (writing changes)\n" : "Mode: DRY RUN (no writes)\n");

  // ── 1. Snapshot ──────────────────────────────────────────────────────────
  const allCats = await Category.find({}).lean();
  const retiredCats = allCats.filter((c) => RETIRED[c.slug] || RETIRED[c.name]);
  const keptCats = allCats.filter((c) => !retiredCats.includes(c));

  console.log("Current categories:", allCats.map((c) => `${c.name}[${c.slug}]`).join(", ") || "(none)");
  console.log("Will keep        :", keptCats.map((c) => c.name).join(", ") || "(none)");
  console.log("Will remove      :", retiredCats.map((c) => `${c.name}[${c.slug}]`).join(", ") || "(none)");
  console.log("Will ensure      :", NEW_CATEGORY);

  // Products that need re-filing
  const affected = await Product.find({ category: { $in: Object.keys(RETIRED) } })
    .select("_id name category")
    .lean();
  console.log(`\nProducts to re-file: ${affected.length}`);
  for (const p of affected) {
    console.log(`  ${p.name}  : "${p.category}" → "${RETIRED[p.category]}"`);
  }

  if (!APPLY) {
    console.log("\nDry run complete. Re-run with --apply to write.");
    await mongoose.disconnect();
    return;
  }

  // ── 2. Backup ────────────────────────────────────────────────────────────
  const backupDir = path.join(__dirname, "..", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `category-retire-${stamp}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify({ database: dbName, categories: allCats, affectedProducts: affected }, null, 2),
  );
  console.log(`\nBacked up to ${backupPath}`);

  // ── 3. Ensure the new Home category exists ───────────────────────────────
  await Category.findOrCreateCategory(NEW_CATEGORY);
  console.log(`Ensured category "${NEW_CATEGORY}"`);

  // ── 4. Re-file products ──────────────────────────────────────────────────
  let moved = 0;
  for (const p of affected) {
    const target = RETIRED[p.category];
    if (!target) continue;
    const r = await Product.updateOne({ _id: p._id }, { $set: { category: target } });
    moved += r.modifiedCount ?? 0;
  }
  console.log(`Re-filed ${moved} product(s)`);

  // ── 5. Remove the retired category documents ─────────────────────────────
  const ids = retiredCats.map((c) => c._id);
  const del = await Category.deleteMany({ _id: { $in: ids } });
  console.log(`Removed ${del.deletedCount} retired category document(s)`);

  // ── 6. Verify ────────────────────────────────────────────────────────────
  const finalCats = await Category.find({}).sort({ name: 1 }).lean();
  console.log("\nFinal categories:");
  for (const c of finalCats) {
    const n = await Product.countDocuments({ category: c.name });
    console.log(`  ${c.name.padEnd(14)} slug=${String(c.slug).padEnd(14)} products=${n}`);
  }
  const orphans = await Product.distinct("category");
  const orphanNames = orphans.filter((o) => !finalCats.some((c) => c.name === o));
  console.log("\nProduct categories with no Category document:", orphanNames.length ? orphanNames : "(none)");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("FAILED:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
