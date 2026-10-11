// Repair legacy shipment records that carry no customer, no points and no
// timestamp.
//
// Background: rows migrated in from the old CSV/supplier collections
// (`mainordercsvdatas`, `MainOrderCSVData`) can arrive with
//   • user: null and userEmail: ""    → the admin panel shows a blank customer,
//                                        which reads as data corruption
//   • pointsAwarded: undefined        → the "already awarded" guard is not
//                                        uniform across rows
//   • no createdAt (only updatedAt)   → the list sorts unpredictably
//
// This script normalizes those rows IN PLACE and tags them, so the admin can
// tell a genuinely unattributed legacy row apart from a real order. It never
// deletes anything by default.
//
// Usage
//   node scripts/repair-legacy-shipment-records.js            report only
//   node scripts/repair-legacy-shipment-records.js --fix      normalize + tag
//   node scripts/repair-legacy-shipment-records.js --dry-run  show the writes
//   node scripts/repair-legacy-shipment-records.js --delete-test --confirm-delete
//                                                             remove rows whose
//                                                             name ends in "Test"
//                                                             and that have no
//                                                             user and no email
require("dotenv").config();
const mongoose = require("mongoose");
const ShipmentRecord = require("../models/ShipmentRecord");

/** A record with no way at all to identify the customer. */
const UNATTRIBUTED = {
  $and: [
    { $or: [{ user: null }, { user: { $exists: false } }] },
    { $or: [{ userEmail: "" }, { userEmail: null }, { userEmail: { $exists: false } }] },
  ],
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not set — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const fix = process.argv.includes("--fix");
  const dryRun = process.argv.includes("--dry-run");
  const deleteTest =
    process.argv.includes("--delete-test") && process.argv.includes("--confirm-delete");

  const rows = await ShipmentRecord.find(UNATTRIBUTED).lean();
  console.log(`Unattributed shipment records: ${rows.length} of ${await ShipmentRecord.countDocuments({})} total.`);

  if (rows.length === 0) {
    console.log("Nothing to repair.");
    await mongoose.disconnect();
    process.exit(0);
  }

  let repaired = 0;
  let alreadyNormal = 0;

  for (const r of rows) {
    const missingCreatedAt = !r.createdAt;
    const missingPoints = r.pointsAwarded === undefined || r.pointsAwarded === null;
    const untagged = r.legacyUnattributed !== true;
    console.log(
      `  ${String(r._id)} | orderID=${r.orderID} | name="${r.name || ""}" | ` +
        `points=${r.pointsAwarded ?? "(unset)"} | createdAt=${missingCreatedAt ? "(unset)" : r.createdAt} | ` +
        `tagged=${!untagged}`,
    );
    if (!fix) continue;

    // Nothing left to normalize — keeps a re-run a true no-op.
    if (!missingCreatedAt && !missingPoints && !untagged) {
      alreadyNormal += 1;
      console.log("    already normalized — skipping");
      continue;
    }

    // Derive a timestamp from the ObjectId when the row has neither createdAt
    // nor updatedAt, so sorting and date filters behave.
    const derived =
      r.createdAt ||
      r.updatedAt ||
      new Date(new mongoose.Types.ObjectId(String(r._id)).getTimestamp());

    const $set = {
      user: null,
      userEmail: "",
      legacyUnattributed: true,
      // An unattributed row can never be double-credited, so an explicit 0 is
      // both accurate and what makes the award guard uniform.
      pointsAwarded: Number(r.pointsAwarded) > 0 ? r.pointsAwarded : 0,
      createdAt: derived,
      updatedAt: r.updatedAt || derived,
    };

    if (dryRun) {
      console.log(`    would set ${JSON.stringify($set)}`);
      continue;
    }

    await ShipmentRecord.collection.updateOne({ _id: r._id }, { $set });
    repaired += 1;
    console.log(`    normalized + tagged (createdAt=${derived.toISOString()}, points=${$set.pointsAwarded})`);
  }

  if (fix && !dryRun) {
    const remaining = await ShipmentRecord.countDocuments(UNATTRIBUTED);
    console.log(
      `\nRepair complete — ${repaired} row(s) normalized, ${alreadyNormal} already normalized, ` +
        `${remaining} unattributed row(s) remain in the database.`,
    );
    console.log("Note: an unattributed row is genuine legacy data with no customer reference. It is now");
    console.log("explicitly tagged `legacyUnattributed` instead of looking like a broken record.");
  }

  if (deleteTest) {
    const testRows = await ShipmentRecord.find({
      ...UNATTRIBUTED,
      name: { $regex: /test\s*$/i },
    })
      .select("_id name orderID")
      .lean();
    if (testRows.length === 0) {
      console.log("\nNo *Test rows to delete.");
    } else {
      for (const t of testRows) {
        console.log(`  deleting ${String(t._id)} | name="${t.name}" | orderID=${t.orderID}`);
      }
      const ids = testRows.map((t) => t._id);
      const res = await ShipmentRecord.deleteMany({ _id: { $in: ids } });
      console.log(`\nDeleted ${res.deletedCount} test row(s).`);
    }
  } else if (rows.some((r) => /test\s*$/i.test(r.name || ""))) {
    console.log(
      "\nHint: some of these look like test rows. Re-run with --delete-test --confirm-delete to remove them.",
    );
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Legacy shipment repair failed:", err.message);
  process.exit(1);
});
