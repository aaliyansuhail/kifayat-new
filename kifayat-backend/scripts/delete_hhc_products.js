/**
 * delete_hhc_products.js — permanently remove the HHC (supplier) catalogue.
 *
 * The old supplier's products were imported straight into `products` and carry
 * their ids in the legacy `retailPrice` / `wholesalePrice` fields. They are not
 * Kifayat stock and are no longer wanted on the store, so this script removes
 * them.
 *
 * Only products whose public id is NOT in the new `kp-00000000001` format are
 * touched — anything an admin has created through the Add Product form is left
 * exactly as it is.
 *
 * Before deleting, every affected document is copied into
 * `_archive_products_hhc` so the purge is reversible: restoring is a matter of
 * copying that collection back into `products`.
 *
 * Usage (from kifayat-backend):
 *   node scripts/delete_hhc_products.js           # dry run — counts only
 *   node scripts/delete_hhc_products.js --apply   # archive + delete
 *   node scripts/delete_hhc_products.js --apply --drop-archive  # delete archive too (irreversible)
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const connectDB = require("../config/db");

const APPLY = process.argv.includes("--apply");
const DROP_ARCHIVE = process.argv.includes("--drop-archive");

const PRODUCTS = "products";
const ARCHIVE = "_archive_products_hhc";
// Anything without a kp- public id came from the supplier import.
const LEGACY_FILTER = { productId: { $not: /^kp-/ } };

(async () => {
  await connectDB();
  if (!mongoose.connection.db) {
    await new Promise((resolve, reject) => {
      mongoose.connection.once("connected", resolve);
      mongoose.connection.once("error", reject);
    });
  }
  const db = mongoose.connection.db;

  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const toDelete = await db.collection(PRODUCTS).countDocuments(LEGACY_FILTER);
  const keep = await db.collection(PRODUCTS).countDocuments({ productId: /^kp-/ });
  const archiveExists = existing.has(ARCHIVE);
  const archiveCount = archiveExists ? await db.collection(ARCHIVE).countDocuments() : 0;

  console.log(APPLY ? "Applying HHC catalogue removal…\n" : "Dry run — nothing will be deleted. Pass --apply to remove.\n");
  console.log(`•  products to remove (no kp- id)   ${toDelete}`);
  console.log(`•  products to keep   (kp- id)      ${keep}`);
  console.log(`•  archive ${ARCHIVE}   ${archiveCount} document(s)${archiveExists ? " (existing)" : " (will be created)"}`);

  if (!APPLY) {
    console.log("\nRun again with --apply to archive and delete.");
    await mongoose.disconnect();
    return;
  }

  // Archive first — server-side copy, so nothing is dragged over the wire.
  if (!archiveExists) {
    await db
      .collection(PRODUCTS)
      .aggregate([{ $match: LEGACY_FILTER }, { $out: ARCHIVE }])
      .toArray();
    console.log(`\nArchived ${await db.collection(ARCHIVE).countDocuments()} product(s) to ${ARCHIVE}.`);
  } else {
    console.log(`\nArchive ${ARCHIVE} already exists — leaving it untouched.`);
  }

  const res = await db.collection(PRODUCTS).deleteMany(LEGACY_FILTER);
  console.log(`Deleted ${res.deletedCount} HHC product(s) from ${PRODUCTS}.`);
  console.log(`Remaining in ${PRODUCTS}: ${await db.collection(PRODUCTS).countDocuments()}.`);

  if (DROP_ARCHIVE) {
    await db.collection(ARCHIVE).drop();
    console.log(`Dropped the ${ARCHIVE} archive — the removal is now irreversible.`);
  } else {
    console.log(`\nThe archive ${ARCHIVE} is kept as a safety net. Drop it with --apply --drop-archive once you are happy.`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error("HHC catalogue removal failed:", err);
  process.exit(1);
});
