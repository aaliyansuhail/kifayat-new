// Migration: make the PreOrder `order` index UNIQUE + SPARSE, as the schema
// declares.
//
// Why: `preOrderSchema.index({ order: 1 }, { unique: true, sparse: true })` is
// what guarantees "one canonical PreOrder per Order" at the database level —
// the confirmation callback and an admin retry can otherwise race and create
// two pending PreOrders for the same order, which then both get confirmed.
//
// MongoDB will not retro-fit options onto an existing index, so a database that
// created `order_1` as a plain index keeps it forever and silently loses the
// guarantee. This step drops the plain index and recreates it with unique +
// sparse.
//
// Safety: it refuses to run when duplicate `order` values exist, because
// creating the unique index would fail anyway — better a clear message than a
// half-applied migration.
//
// Idempotent — safe to run more than once.
//
// Usage: node scripts/migrate-preorder-order-index.js
// (Also runs as a tracked step of `node scripts/migrate.js`.)
require("dotenv").config();
const mongoose = require("mongoose");
const PreOrder = require("../models/PreOrder");

const INDEX_NAME = "order_1";

/** Live state of the { order: 1 } index, without changing anything. */
async function inspectPreOrderOrderIndex() {
  const list = await PreOrder.collection.listIndexes().toArray().catch(() => []);
  const idx = list.find((i) => i.key && Object.keys(i.key).join(",") === "order");
  if (!idx) return { exists: false, unique: false, sparse: false, name: null };
  return {
    exists: true,
    unique: !!idx.unique,
    sparse: !!idx.sparse,
    name: idx.name,
  };
}

/**
 * Core migration body — assumes an open Mongoose connection.
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{changed: boolean, ok: boolean, reason?: string}>}
 */
async function migratePreOrderOrderIndex(log = console.log) {
  const before = await inspectPreOrderOrderIndex();

  if (before.exists && before.unique) {
    log(`Index '${INDEX_NAME}' is already unique — nothing to do.`);
    return { changed: false, ok: true };
  }

  // Refuse when the data would violate the constraint.
  const duplicates = await PreOrder.collection
    .aggregate([
      { $match: { order: { $ne: null } } },
      { $group: { _id: "$order", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 5 },
    ])
    .toArray()
    .catch(() => []);

  if (duplicates.length > 0) {
    log(
      `Refusing to make '${INDEX_NAME}' unique: ${duplicates.length} order id(s) have more than one ` +
        `PreOrder (e.g. ${duplicates.map((d) => String(d._id)).join(", ")}). ` +
        `Resolve those duplicates first, then re-run.`,
    );
    return { changed: false, ok: false, reason: "duplicate_order_ids" };
  }

  if (before.exists) {
    log(`Dropping plain index '${before.name || INDEX_NAME}' on { order: 1 }...`);
    await PreOrder.collection.dropIndex(before.name || INDEX_NAME);
  }

  log("Creating unique + sparse index on { order: 1 }...");
  await PreOrder.collection.createIndex(
    { order: 1 },
    { unique: true, sparse: true, name: INDEX_NAME },
  );

  const after = await inspectPreOrderOrderIndex();
  if (after.unique) {
    log(`Index ready: '${after.name}' unique=${after.unique} sparse=${after.sparse}`);
    return { changed: true, ok: true };
  }

  log("WARNING: the unique index was not created — check the server logs.");
  return { changed: true, ok: false, reason: "not_created" };
}

module.exports = { migratePreOrderOrderIndex, inspectPreOrderOrderIndex, INDEX_NAME };

// ── Standalone CLI ───────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error("MONGODB_URI not set — aborting.");
      process.exit(1);
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
    const { ok } = await migratePreOrderOrderIndex();
    await mongoose.disconnect();
    process.exit(ok ? 0 : 1);
  })().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  });
}
