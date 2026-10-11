/**
 * purge_catalogue.js — one-off cleanup after the supplier (HHC) contract ended.
 *
 * Deletes:
 *   • products                    — the whole imported catalogue (and any
 *                                    seller listings, which share the collection)
 *   • outofstockdeletedproducts   — the out-of-stock graveyard
 *   • productinteractions         — hover/click/view telemetry for those products
 *   • dynamicdata                 — legacy supplier dynamic-data cache
 *   • "price ranges profit margin" — legacy margin rules
 *   • pricediagnostics            — legacy price monitor runs
 *
 * Keeps: orders, pre-orders, shipment records, receipts, users, vouchers,
 * categories and settings — those are real customer/store data.
 *
 * Usage (from kifayat-backend):
 *   node scripts/purge_catalogue.js              # dry run — counts only
 *   node scripts/purge_catalogue.js --apply      # actually delete
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const connectDB = require("../config/db");

const APPLY = process.argv.includes("--apply");

// Collection names must match what MongoDB actually holds — Mongoose derives
// the name from the model (plus any explicit `collection:`), which is why the
// real names are snake_case and not the camelCase model names.
//
// Deliberately NOT included: `products`. Removing catalogue documents is a
// separate, per-product decision handled by scripts/delete_hhc_products.js,
// which only touches rows without a kp- public id and archives them first.
const COLLECTIONS = [
  ["out_of_stock_deleted_products", "out-of-stock product archive"],
  ["product_interactions", "product engagement events"],
  ["dynamicdata", "legacy supplier dynamic data"],
  ["price ranges profit margin", "legacy price ranges"],
  ["price_diagnostics", "legacy price diagnostics"],
  ["syncstates", "legacy supplier sync state"],
];

(async () => {
  await connectDB();
  if (!mongoose.connection.db) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once("connected", resolve);
      mongoose.connection.once("error", reject);
    });
  }
  const db = mongoose.connection.db;

  const existing = new Set(
    (await db.listCollections().toArray()).map((c) => c.name),
  );

  let total = 0;
  for (const [name, label] of COLLECTIONS) {
    if (!existing.has(name)) {
      console.log(`—  ${label.padEnd(34)} (collection "${name}" not present)`);
      continue;
    }
    const count = await db.collection(name).countDocuments();
    total += count;
    console.log(`${APPLY ? "🗑️ " : "• "} ${label.padEnd(34)} ${count} document(s)`);
    if (APPLY && count > 0) {
      await db.collection(name).deleteMany({});
    }
  }

  console.log(
    APPLY
      ? `\n✅ Deleted ${total} document(s). The catalogue is now empty — add products from Admin → Add Product.`
      : `\nℹ️  Dry run: ${total} document(s) would be deleted. Re-run with --apply to delete them.`,
  );

  await mongoose.connection.close();
  process.exit(0);
})().catch(async (err) => {
  console.error("purge_catalogue failed:", err);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
