// One-time migration: extend the product $text search index to include the
// `keywords` array (per-product SEO), and backfill generated keywords for every
// product that doesn't have one yet — so ALL products are searchable by
// phrases like "best hand gripper" immediately.
//
// MongoDB $text indexes are IMMUTABLE — a field cannot be added to an existing
// text index, and creating a second text index on the same collection fails
// with IndexOptionsConflict. The fix is to drop the old text index and let
// Mongoose rebuild it from the schema.
//
// This script is idempotent: it only drops a text index whose keys differ from
// the schema's current set, then calls Product.init() to (re)create the schema
// index, then backfills keywords for products that have none. Safe to run
// multiple times.
//
// Usage: node scripts/migrate-text-index.js
// (Also runs as a tracked step of `node scripts/migrate.js`.)
require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product");
const { generateKeywords } = require("../utils/seoKeywords");

// The key set the schema now declares. MongoDB describes text fields with the
// literal value "text".
const SCHEMA_TEXT_KEYS = {
  name: "text",
  description: "text",
  sku: "text",
  productId: "text",
  keywords: "text",
};

/**
 * The live text index (if any), as MongoDB describes it.
 *
 * A text index's `key` is always { _fts: "text", _ftsx: 1 }; the fields it
 * actually covers live in `weights`. Comparing `key` would make this check
 * always report "different" and drop/recreate the index on every run.
 */
async function inspectProductTextIndex() {
  const list = await Product.collection.listIndexes().toArray().catch(() => []);
  const idx = list.find((i) => Object.values(i.key ?? {}).includes("text"));
  if (!idx) return { exists: false, matchesSchema: false, keys: [] };
  const keys = Object.keys(idx.weights ?? {}).sort();
  const matchesSchema = keys.join(",") === Object.keys(SCHEMA_TEXT_KEYS).sort().join(",");
  return { exists: true, matchesSchema, keys };
}

/**
 * Core migration body — assumes an open Mongoose connection.
 * Idempotent: rebuilds the text index only when its keys differ from the
 * schema, then backfills keywords for products that have none.
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{changed: boolean, keywordsBackfilled: number}>}
 */
async function migrateTextIndex(log = console.log) {
  let changed = false;

  const before = await inspectProductTextIndex();
  if (before.exists && before.matchesSchema) {
    log(`Text index already matches the schema — nothing to do.`);
  } else if (before.exists) {
    log(`Dropping legacy text index (keys: ${before.keys.join(", ")})...`);
    const list = await Product.collection.listIndexes().toArray().catch(() => []);
    const legacy = list.find((i) => Object.values(i.key ?? {}).includes("text"));
    if (legacy) await Product.collection.dropIndex(legacy.name);
    changed = true;
  } else {
    log("No text index found to migrate.");
  }

  if (changed) {
    log("Rebuilding schema text index (name, description, sku, productId, keywords)...");
    await Product.init();
    const after = await inspectProductTextIndex();
    if (after.exists) {
      log(`New text index ready -> ${JSON.stringify(after.keys)}`);
    } else {
      console.error("WARNING: no text index found after rebuild — check server logs.");
    }
  }

  // ── Backfill keywords for products that have none ────────────────────────
  // Covers products created before this feature: they hold keywords null /
  // "" / [] and were never touched by sync or the AI booster. Generate base
  // keywords from name + category so search finds them immediately.
  const missingFilter = {
    $or: [
      { keywords: { $exists: false } },
      { keywords: null },
      { keywords: [] },
      { keywords: { $size: 0 } },
    ],
  };
  const missing = await Product.find(missingFilter).select("_id name category").lean();

  let done = 0;
  if (missing.length === 0) {
    log("Keyword backfill: all products already have keywords — nothing to do.");
  } else {
    log(`Keyword backfill: generating keywords for ${missing.length} products...`);
    const upserts = missing.map((p) => ({
      updateOne: {
        filter: { _id: p._id },
        update: { $set: { keywords: generateKeywords(p.name, p.category) } },
        upsert: false,
      },
    }));
    const CHUNK = 500;
    for (let i = 0; i < upserts.length; i += CHUNK) {
      const chunk = upserts.slice(i, i + CHUNK);
      const res = await Product.bulkWrite(chunk);
      done += res.modifiedCount;
      log(`  keywords backfilled: ${done}/${missing.length}`);
    }
    log(`Keyword backfill complete — ${done} products updated.`);
  }

  return { changed, keywordsBackfilled: done };
}

module.exports = { migrateTextIndex, inspectProductTextIndex, SCHEMA_TEXT_KEYS };

// ── Standalone CLI ───────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error("MONGODB_URI not set — aborting.");
      process.exit(1);
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
    await migrateTextIndex();
    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  });
}
