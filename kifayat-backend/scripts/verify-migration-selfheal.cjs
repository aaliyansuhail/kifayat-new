// Regression check for the boot migrations: a database that still carries the
// LEGACY (non-partial) purchased-voucher index must converge on boot.
//
// Builds a scratch database in the configured cluster with the old index, runs
// the same migration the server runs on boot, asserts the index becomes unique
// + partial, asserts a re-run is a no-op, and asserts the user-visible symptom
// (buying two vouchers in a row) works there. Drops the scratch database.
//
// Usage: npm run test:migration-selfheal
require("dotenv").config();
const mongoose = require("mongoose");

// A dedicated scratch database — this script creates and drops ONLY this one.
const SCRATCH_DB = "kifayat_migration_probe";
const LEGACY = "user_1_applied_products.product_1";

function uriWithDb(uri, db) {
  const u = new URL(uri);
  u.pathname = `/${db}`;
  return u.toString();
}

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  const uri = uriWithDb(process.env.MONGODB_URI, SCRATCH_DB);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  await mongoose.connection.db.dropDatabase();

  // ── Build the LEGACY state: a plain (non-partial) unique index ──────────
  const col = mongoose.connection.db.collection("purchased_vouchers");
  await col.createIndex(
    { user: 1, "applied_products.product": 1 },
    { unique: true, name: LEGACY },
  );
  const before = (await col.listIndexes().toArray()).find((i) => i.name === LEGACY);
  console.log("legacy index before:", JSON.stringify({ unique: before.unique, partial: before.partialFilterExpression }));
  check("starts NON-partial (the broken legacy state)", !before.partialFilterExpression);

  // Loading the model is what mongoose does at require() time.
  require("../models/PurchasedVoucher");

  // ── Run exactly what the server runs on boot ────────────────────────────
  const { runMigrations, migrationStatus } = require("./migrate");
  const statusBefore = await migrationStatus();
  console.log("pending before:", statusBefore.pending.join(", ") || "(none)");
  check("the index step is detected as pending", statusBefore.pending.includes("001-applied-products-partial-index"));

  const result = await runMigrations({ log: () => {} });
  check("migration run reported ok", result.ok === true, JSON.stringify(result));
  check("it applied the index step", result.applied.includes("001-applied-products-partial-index"));

  const after = (await col.listIndexes().toArray()).find((i) => i.name === LEGACY);
  console.log("index after:", JSON.stringify({ unique: after.unique, partial: after.partialFilterExpression }));
  check("index is now UNIQUE + PARTIAL", !!after.unique && !!after.partialFilterExpression);

  // ── Idempotency: a second run must be a no-op ───────────────────────────
  const second = await runMigrations({ log: () => {} });
  check("second run is a no-op", second.applied.length === 0, `applied ${second.applied.join(",")}`);

  // ── The actual user-visible symptom: two vouchers in a row ──────────────
  // On the fixed index, two docs with NO applied products no longer collide.
  const userId = new mongoose.Types.ObjectId();
  await col.insertOne({ user: userId, applied_products: [] });
  let secondBuyOk = true;
  try {
    await col.insertOne({ user: userId, applied_products: [] });
  } catch (e) {
    secondBuyOk = false;
  }
  check("buying 2 vouchers in a row works on the repaired index", secondBuyOk);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("PROBE ERROR:", e.message);
  try { await mongoose.connection.db?.dropDatabase(); } catch {}
  process.exit(1);
});
