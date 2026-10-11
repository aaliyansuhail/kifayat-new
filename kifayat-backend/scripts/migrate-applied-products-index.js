// One-time migration: turn the purchased-voucher "one voucher use per product
// per user" index into a PARTIAL unique index.
//
// Why: a freshly bought voucher has an empty `applied_products` array, and a
// plain multikey unique index indexes that as
//   { user: <uid>, applied_products.product: null }
// so a customer buying a SECOND voucher before applying the first hit
//   E11000 duplicate key error ... dup key: { applied_products.product: null }
// and the purchase failed with a 500.
//
// The schema now declares the index with
//   partialFilterExpression: { "applied_products.product": { $exists: true } }
// which skips documents that have no applied products while keeping the
// one-voucher-per-product guarantee for the ones that do.
//
// MongoDB will not change an existing index's options, so the legacy index has
// to be dropped before Mongoose can rebuild it. Idempotent — safe to run more
// than once.
//
// Usage: node scripts/migrate-applied-products-index.js
// (Also runs as a tracked step of `node scripts/migrate.js`.)
require("dotenv").config();
const mongoose = require("mongoose");
const PurchasedVoucher = require("../models/PurchasedVoucher");

const INDEX_NAME = "user_1_applied_products.product_1";
// The exact index the schema wants. Created through the driver rather than
// Model.init() on purpose: Mongoose caches its first index-build attempt, and
// on a database that still has the legacy (non-partial) index with the SAME
// name that attempt already failed — so init() keeps resolving to that stale
// rejection even after the legacy index has been dropped. Building the index
// explicitly is deterministic and does not depend on that cached promise.
const INDEX_KEY = { user: 1, "applied_products.product": 1 };
const PARTIAL_FILTER = { "applied_products.product": { $exists: true } };

/** Create the unique partial index, tolerating an existing conflicting one. */
async function createPartialIndex() {
  const options = {
    unique: true,
    name: INDEX_NAME,
    partialFilterExpression: PARTIAL_FILTER,
  };
  try {
    await PurchasedVoucher.collection.createIndex(INDEX_KEY, options);
  } catch (err) {
    // 85 = IndexOptionsConflict, 86 = IndexKeySpecsConflict. An index with this
    // name exists with the old options; replace it explicitly.
    if (err.code === 85 || err.code === 86) {
      await PurchasedVoucher.collection.dropIndex(INDEX_NAME).catch(() => {});
      await PurchasedVoucher.collection.createIndex(INDEX_KEY, options);
      return;
    }
    throw err;
  }
}

/**
 * Core migration body — assumes an open Mongoose connection.
 * Idempotent: reports "nothing to do" when the partial index already exists.
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{changed: boolean, ok: boolean}>}
 */
async function migrateAppliedProductsIndex(log = console.log) {
  const existing = (await PurchasedVoucher.collection.listIndexes().toArray().catch(() => []))
    .find((i) => i.name === INDEX_NAME);

  let changed = false;

  if (!existing) {
    log(`Index '${INDEX_NAME}' does not exist yet — creating the partial one.`);
    await createPartialIndex();
    changed = true;
  } else if (existing.partialFilterExpression) {
    log(
      `Index '${INDEX_NAME}' is already partial ` +
        `(${JSON.stringify(existing.partialFilterExpression)}) — nothing to do.`,
    );
    return { changed: false, ok: true };
  } else {
    log(`Dropping legacy non-partial unique index '${INDEX_NAME}'...`);
    await PurchasedVoucher.collection.dropIndex(INDEX_NAME);
    log("Rebuilding it with the partial filter...");
    await createPartialIndex();
    changed = true;
  }

  const rebuilt = (await PurchasedVoucher.collection.listIndexes().toArray().catch(() => []))
    .find((i) => i.name === INDEX_NAME);

  if (rebuilt?.partialFilterExpression) {
    log(`Index ready: '${rebuilt.name}' unique=${!!rebuilt.unique} ${JSON.stringify(rebuilt.partialFilterExpression)}`);
    return { changed, ok: true };
  }

  log("WARNING: the partial index was not created — check the server logs.");
  return { changed, ok: false };
}

/** Inspect the live index without changing anything (used by the drift check). */
async function inspectAppliedProductsIndex() {
  const idx = (await PurchasedVoucher.collection.listIndexes().toArray().catch(() => []))
    .find((i) => i.name === INDEX_NAME);
  if (!idx) return { exists: false, partial: false, unique: false };
  return {
    exists: true,
    partial: !!idx.partialFilterExpression,
    unique: !!idx.unique,
  };
}

module.exports = { migrateAppliedProductsIndex, inspectAppliedProductsIndex, INDEX_NAME };

// ── Standalone CLI ───────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error("MONGODB_URI not set — aborting.");
      process.exit(1);
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
    const { ok } = await migrateAppliedProductsIndex();
    await mongoose.disconnect();
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  });
}
