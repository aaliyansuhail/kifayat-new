/**
 * migrate_shipment_records.js — one-off fix for the shipment queue.
 *
 * The ShipmentRecord model used to write to Mongoose's default collection for
 * the model name "MainOrderCSVData", i.e. `mainordercsvdatas`. A later rename
 * pointed the model at a differently-cased literal ("MainOrderCSVData") and
 * split the queue in two, so confirmed orders sitting in the old collection
 * were invisible to the admin "Shipment Details" page and to customer
 * "Your Orders". The model now uses the clean `shipment_records` collection.
 *
 * This script copies every record from both legacy collections into
 * `shipment_records` (skipping ones already there, keyed on `orderID`) so no
 * confirmed order is lost.
 *
 * Usage (from kifayat-backend):
 *   node scripts/migrate_shipment_records.js           # dry run
 *   node scripts/migrate_shipment_records.js --apply   # copy rows
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const connectDB = require("../config/db");

const APPLY = process.argv.includes("--apply");
const LEGACY = ["mainordercsvdatas", "MainOrderCSVData"];
const TARGET = "shipment_records";

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

  console.log(APPLY ? "Applying shipment-record migration…\n" : "Dry run — no writes. Pass --apply to migrate.\n");

  let copied = 0;
  let skipped = 0;

  for (const name of LEGACY) {
    if (!existing.has(name)) {
      console.log(`—  ${name.padEnd(22)} (not present)`);
      continue;
    }
    const docs = await db.collection(name).find({}).toArray();
    console.log(`•  ${name.padEnd(22)} ${docs.length} document(s)`);

    for (const doc of docs) {
      const orderID = doc.orderID;
      if (!orderID) continue;
      const already = await db.collection(TARGET).findOne({ orderID });
      if (already) {
        skipped++;
        continue;
      }
      if (!APPLY) {
        copied++;
        continue;
      }
      const { _id, ...rest } = doc;
      await db.collection(TARGET).updateOne(
        { orderID },
        { $setOnInsert: { ...rest, orderID } },
        { upsert: true },
      );
      copied++;
    }
  }

  console.log(`\n${APPLY ? "Copied" : "Would copy"}: ${copied} · already present: ${skipped}`);
  if (APPLY) {
    console.log(`\n${TARGET} now holds ${await db.collection(TARGET).countDocuments()} record(s).`);
    console.log("The legacy collections are left untouched — drop them once you have verified the admin Shipment Details page.");
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error("Shipment-record migration failed:", err);
  process.exit(1);
});
