// Demo / workflow-test data: inspect and remove it precisely.
//
// What this is for
// ────────────────
// The order + voucher workflows were verified end to end with a throwaway
// customer account. That verification left real documents in the database
// (vouchers, a pending pre-order, a confirmed shipment record, loyalty points).
// This script reports exactly what exists and removes exactly that — nothing
// else. It is deliberately narrow: it works from ONE email address and follows
// the references outward from there.
//
// Usage
//   node scripts/demo-data.js                 report what exists
//   node scripts/demo-data.js --clean --dry-run   show exactly what would go
//   node scripts/demo-data.js --clean             delete it
//   node scripts/demo-data.js --clean --keep-user keep the account, delete the rest
//
// Nothing runs by accident: --clean is required to delete anything.
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const Session = require("../models/Session");
const LoginHistory = require("../models/LoginHistory");
const ActivityLog = require("../models/ActivityLog");
const Order = require("../models/Order");
const PreOrder = require("../models/PreOrder");
const ShipmentRecord = require("../models/ShipmentRecord");
const ShippingDetail = require("../models/ShippingDetail");
const CancelOrder = require("../models/CancelOrder");
const CancelledOrders = require("../models/CancelledOrders");
const LateConfirmationOrder = require("../models/LateConfirmationOrder");
const PurchasedVoucher = require("../models/PurchasedVoucher");
const DiscountVoucher = require("../models/DiscountVoucher");
const Cart = require("../models/Cart");

// The throwaway account used to verify the order/voucher workflows.
const DEMO_EMAIL = process.env.DEMO_DATA_EMAIL || "wf-customer@kifayat.co";

/** Everything tied to the demo account, gathered by reference from the user doc. */
async function collectDemoData() {
  const user = await User.findOne({ email: DEMO_EMAIL }).select("_id name email loyaltyPoints").lean();
  if (!user) {
    return { user: null, counts: {}, docs: {} };
  }

  const [orders, preOrders, shipments, shipping, cancels, cancelled, late, vouchers, sessions, logins, activity, cart] =
    await Promise.all([
      Order.find({ user: user._id }).select("_id totalAmount").lean(),
      PreOrder.find({ user: user._id }).select("_id order").lean(),
      ShipmentRecord.find({
        $or: [{ user: user._id }, { userEmail: DEMO_EMAIL }],
      }).select("_id orderID pointsAwarded").lean(),
      ShippingDetail.find({ user: user._id }).select("_id order").lean(),
      CancelOrder.find({ user: user._id }).select("_id").lean(),
      CancelledOrders.find({ user: user._id }).select("_id").lean(),
      LateConfirmationOrder.find({ user: user._id }).select("_id").lean(),
      PurchasedVoucher.find({ user: user._id }).select("_id voucher voucher_code source").lean(),
      Session.find({ user: user._id }).select("_id").lean(),
      LoginHistory.find({ userId: user._id }).select("_id").lean(),
      ActivityLog.find({ $or: [{ admin: user._id }, { targetUser: user._id }] }).select("_id").lean(),
      Cart.find({ user: user._id }).select("_id").lean(),
    ]);

  // A published voucher bought by the demo account would otherwise stay marked
  // `purchased_by` forever and could never be bought by anyone.
  const voucherIds = vouchers.map((v) => v.voucher).filter(Boolean);
  const publishedVouchers = voucherIds.length
    ? await DiscountVoucher.find({ _id: { $in: voucherIds } })
        .select("_id voucher_code purchased_by")
        .lean()
    : [];

  const docs = {
    orders,
    preOrders,
    shipments,
    shipping,
    cancels,
    cancelled,
    late,
    vouchers,
    publishedVouchers,
    sessions,
    logins,
    activity,
    cart,
  };

  const counts = Object.fromEntries(
    Object.entries(docs).map(([k, v]) => [k, v.length]),
  );

  return { user, counts, docs };
}

function printReport({ user, counts, docs }) {
  if (!user) {
    console.log(`No demo account found for ${DEMO_EMAIL} — nothing to clean.`);
    return false;
  }

  console.log(`Demo account: ${user.name} <${user.email}>  _id=${String(user._id)}  points=${user.loyaltyPoints ?? 0}`);
  console.log("");
  const labels = {
    orders: "Orders (pending)",
    preOrders: "PreOrders (unconfirmed)",
    shipments: "Shipment records (confirmed)",
    shipping: "Shipping details",
    cancels: "CancelOrder rows",
    cancelled: "CancelledOrders rows",
    late: "Late-confirmation rows",
    vouchers: "Purchased vouchers",
    publishedVouchers: "Published vouchers bought by this account",
    sessions: "Sessions",
    logins: "Login history rows",
    activity: "Activity log rows",
    cart: "Saved cart",
  };
  for (const [key, label] of Object.entries(labels)) {
    console.log(`  ${String(counts[key] ?? 0).padStart(3)}  ${label}`);
  }

  if (docs.shipments.length) {
    console.log("\n  Shipment records:");
    for (const s of docs.shipments) {
      console.log(`    orderID=${s.orderID} pointsAwarded=${s.pointsAwarded ?? 0}`);
    }
  }
  if (docs.vouchers.length) {
    console.log("\n  Purchased vouchers:");
    for (const v of docs.vouchers) {
      console.log(`    ${v.voucher_code || "(no code)"} (${v.source})`);
    }
  }
  if (docs.publishedVouchers.length) {
    console.log("\n  Published vouchers that will also be removed:");
    for (const v of docs.publishedVouchers) {
      console.log(`    ${v.voucher_code} purchased_by=${v.purchased_by ?? "null"}`);
    }
  }
  return true;
}

async function clean({ dryRun, keepUser }) {
  const { user, docs } = await collectDemoData();
  if (!user) {
    console.log("Nothing to clean.");
    return { deleted: {} };
  }

  const plan = [
    ["shipment_records", ShipmentRecord, { _id: { $in: docs.shipments.map((d) => d._id) } }],
    ["pre_orders", PreOrder, { _id: { $in: docs.preOrders.map((d) => d._id) } }],
    ["orders", Order, { _id: { $in: docs.orders.map((d) => d._id) } }],
    ["shipping_details", ShippingDetail, { _id: { $in: docs.shipping.map((d) => d._id) } }],
    ["cancel_orders", CancelOrder, { _id: { $in: docs.cancels.map((d) => d._id) } }],
    ["CancelledOrders", CancelledOrders, { _id: { $in: docs.cancelled.map((d) => d._id) } }],
    ["late_confirmation_orders", LateConfirmationOrder, { _id: { $in: docs.late.map((d) => d._id) } }],
    ["purchased_vouchers", PurchasedVoucher, { _id: { $in: docs.vouchers.map((d) => d._id) } }],
    ["discount_vouchers", DiscountVoucher, { _id: { $in: docs.publishedVouchers.map((d) => d._id) } }],
    ["cart", Cart, { _id: { $in: docs.cart.map((d) => d._id) } }],
    ["UserSessions", Session, { _id: { $in: docs.sessions.map((d) => d._id) } }],
    ["LoginHistory", LoginHistory, { _id: { $in: docs.logins.map((d) => d._id) } }],
    ["activity_logs", ActivityLog, { _id: { $in: docs.activity.map((d) => d._id) } }],
  ];

  const deleted = {};
  for (const [label, Model, filter] of plan) {
    if (!filter._id.$in.length) {
      deleted[label] = 0;
      continue;
    }
    if (dryRun) {
      deleted[label] = await Model.countDocuments(filter);
      continue;
    }
    const res = await Model.deleteMany(filter);
    deleted[label] = res.deletedCount || 0;
  }

  if (!keepUser) {
    if (dryRun) {
      deleted.SignupUsers = 1;
    } else {
      const res = await User.deleteOne({ _id: user._id });
      deleted.SignupUsers = res.deletedCount || 0;
    }
  }

  return { deleted };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI not set — aborting.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const doClean = process.argv.includes("--clean");
  const dryRun = process.argv.includes("--dry-run");
  const keepUser = process.argv.includes("--keep-user");

  const data = await collectDemoData();
  const exists = printReport(data);

  if (!doClean) {
    if (exists) {
      console.log("\nReport only. Re-run with --clean to remove the above (add --dry-run to preview).");
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!exists) {
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("");
  const { deleted } = await clean({ dryRun, keepUser });
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  console.log(`${dryRun ? "WOULD DELETE" : "DELETED"} ${total} document(s):`);
  for (const [label, n] of Object.entries(deleted)) {
    if (n > 0) console.log(`  ${String(n).padStart(3)}  ${label}`);
  }
  if (keepUser) console.log("  (demo account kept — --keep-user)");

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Demo data script failed:", err.message);
  process.exit(1);
});
