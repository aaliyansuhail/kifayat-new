// ─── Tracked migration runner ───────────────────────────────────────────────
//
// Why this exists
// ───────────────
// The schema declares indexes and backfills that a given database may not
// actually have. Two stand-alone scripts used to fix those by hand, which meant
// every environment (a fresh clone, a staging DB, a restored backup) had to
// remember to run them — and silently broke in a different way when it didn't.
// (Buying a second voucher before applying the first 500'd on any database
// where the partial-index script had not been run.)
//
// This runner makes convergence explicit and repeatable:
//   • ordered, named steps
//   • each step idempotent (safe to re-run)
//   • applied steps recorded in a `migrations` collection, so a re-run is a
//     cheap no-op instead of redoing work
//   • a failure stops the run and reports which step failed
//
// Usage
//   node scripts/migrate.js           apply every pending step
//   node scripts/migrate.js --check   report pending steps only (exit 1 if any)
//
// It is also callable from the server (RUN_MIGRATIONS_ON_BOOT=true) via
// runMigrations(); in that mode a failure is logged and reported, never fatal.
require("dotenv").config();
const mongoose = require("mongoose");

const {
  migrateAppliedProductsIndex,
  inspectAppliedProductsIndex,
} = require("./migrate-applied-products-index");
const { migrateTextIndex, inspectProductTextIndex } = require("./migrate-text-index");
const {
  migratePreOrderOrderIndex,
  inspectPreOrderOrderIndex,
} = require("./migrate-preorder-order-index");

const COLLECTION = "migrations";

// ─── Steps ──────────────────────────────────────────────────────────────────
// Order matters. Add new steps at the end; never renumber an existing one.
const STEPS = [
  {
    id: "001-applied-products-partial-index",
    name: "Purchased-voucher index is uniquely partial on {user, applied_products.product}",
    up: (log) => migrateAppliedProductsIndex(log),
    // Does the live database actually look like this step ran? Checked before
    // every run, so a database restored from an older backup — where the step
    // is recorded but the index is not — converges instead of silently staying
    // broken.
    isSatisfied: async () => {
      const idx = await inspectAppliedProductsIndex();
      return idx.exists && idx.unique && idx.partial;
    },
  },
  {
    id: "002-product-text-index-and-keywords",
    name: "Product $text index includes keywords; every product has searchable keywords",
    up: (log) => migrateTextIndex(log),
    isSatisfied: async () => {
      const idx = await inspectProductTextIndex();
      return idx.exists && idx.matchesSchema;
    },
  },
  {
    id: "003-preorder-order-unique-index",
    name: "PreOrder index on { order } is unique + sparse (one canonical pre-order per order)",
    up: (log) => migratePreOrderOrderIndex(log),
    isSatisfied: async () => {
      const idx = await inspectPreOrderOrderIndex();
      return idx.exists && idx.unique;
    },
  },
];

/** The `migrations` bookkeeping collection. */
function migrationsCollection(db) {
  return db.collection(COLLECTION);
}

/** Ids of steps already applied in this database. */
async function appliedStepIds(db) {
  const rows = await migrationsCollection(db).find({}).toArray().catch(() => []);
  return new Set(rows.map((r) => r.id));
}

/**
 * Steps this database still needs, in order: never applied, OR recorded as
 * applied but whose effect is not actually present (restored backup, someone
 * dropped the index by hand).
 */
async function pendingSteps(db) {
  const applied = await appliedStepIds(db);
  const pending = [];
  for (const step of STEPS) {
    if (!applied.has(step.id)) {
      pending.push(step);
      continue;
    }
    if (typeof step.isSatisfied === "function") {
      let satisfied = true;
      try {
        satisfied = await step.isSatisfied();
      } catch {
        // A check that cannot run is not a reason to redo the migration.
        satisfied = true;
      }
      if (!satisfied) pending.push(step);
    }
  }
  return pending;
}

/**
 * Apply every pending step. Never throws — returns a result object so a caller
 * inside the server can decide what to do with a failure.
 * @returns {Promise<{ok: boolean, applied: string[], skipped: number, failed?: string, error?: string}>}
 */
async function runMigrations({ log = console.log, db = mongoose.connection.db } = {}) {
  if (!db) return { ok: false, applied: [], skipped: 0, error: "No database connection." };

  const pending = await pendingSteps(db);
  if (pending.length === 0) {
    log("Migrations: nothing pending — database is up to date.");
    return { ok: true, applied: [], skipped: STEPS.length };
  }

  const applied = [];
  for (const step of pending) {
    log(`Migrations: applying ${step.id} — ${step.name}`);
    try {
      await step.up(log);
    } catch (err) {
      log(`Migrations: FAILED at ${step.id} — ${err.message}`);
      return { ok: false, applied, skipped: STEPS.length - pending.length, failed: step.id, error: err.message };
    }
    // Record only after the step succeeded, so a crash mid-step re-runs it.
    try {
      await migrationsCollection(db).updateOne(
        { id: step.id },
        { $set: { id: step.id, name: step.name, appliedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      log(`Migrations: applied ${step.id} but could not record it — ${err.message}`);
    }
    applied.push(step.id);
  }

  log(`Migrations: applied ${applied.length} step(s).`);
  return { ok: true, applied, skipped: STEPS.length - pending.length };
}

/** Report which steps are still needed without applying anything. */
async function migrationStatus({ db = mongoose.connection.db } = {}) {
  if (!db) return { applied: [], pending: STEPS.map((s) => s.id), drifted: [] };
  const applied = await appliedStepIds(db);
  const pending = await pendingSteps(db);
  const pendingIds = new Set(pending.map((s) => s.id));
  return {
    applied: STEPS.filter((s) => applied.has(s.id) && !pendingIds.has(s.id)).map((s) => s.id),
    pending: pending.map((s) => s.id),
    // Recorded as applied but the effect is missing — worth calling out.
    drifted: pending.filter((s) => applied.has(s.id)).map((s) => s.id),
  };
}

module.exports = { STEPS, runMigrations, migrationStatus, pendingSteps, COLLECTION };

// ── Standalone CLI ───────────────────────────────────────────────────────────
if (require.main === module) {
  const checkOnly = process.argv.includes("--check");

  (async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error("MONGODB_URI not set — aborting.");
      process.exit(1);
    }
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

    if (checkOnly) {
      const status = await migrationStatus();
      console.log(`Migrations applied : ${status.applied.join(", ") || "(none)"}`);
      console.log(`Migrations pending : ${status.pending.join(", ") || "(none)"}`);
      if (status.drifted.length > 0) {
        console.log(`Migrations drifted : ${status.drifted.join(", ")} (recorded, but the change is missing)`);
      }
      await mongoose.disconnect();
      process.exit(status.pending.length === 0 ? 0 : 1);
    }

    const result = await runMigrations();
    await mongoose.disconnect();
    process.exit(result.ok ? 0 : 1);
  })().catch((err) => {
    console.error("Migration run failed:", err.message);
    process.exit(1);
  });
}
