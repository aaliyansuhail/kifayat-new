// End-to-end check of the voucher minimum-units rule through the real
// controllers (publish -> buy -> apply -> placeOrder -> cleanup).
//
// Creates its own throwaway user/product vouchers and removes every document it
// creates, so it is safe to run against the development database.
//
// Usage: npm run test:voucher-min-units
require("dotenv").config();
const mongoose = require("mongoose");

const User = require("../models/User");
const Product = require("../models/Product");
const DiscountVoucher = require("../models/DiscountVoucher");
const PurchasedVoucher = require("../models/PurchasedVoucher");
const Order = require("../models/Order");
const PreOrder = require("../models/PreOrder");
const ShippingDetail = require("../models/ShippingDetail");

const voucherController = require("../controllers/voucherController");
const orderController = require("../controllers/orderController");
const { voucherConditionSummary } = require("../utils/voucherRules");

let pass = 0;
let fail = 0;
const failures = [];
function check(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Minimal Express req/res doubles that capture the handler's response. */
function mockReq(body = {}, user = null) {
  return {
    body,
    user,
    cookies: {},
    headers: {},
    params: {},
    get: () => "",
    app: { get: () => null },
  };
}
function mockRes() {
  const captured = { status: 200, payload: null };
  const res = {
    status(code) {
      captured.status = code;
      return this;
    },
    json(payload) {
      captured.payload = payload;
      return this;
    },
    set() {
      return this;
    },
    header() {
      return this;
    },
  };
  return { res, captured };
}

const created = {
  users: [],
  vouchers: [],
  purchased: [],
  orders: [],
  preOrders: [],
  shipping: [],
};

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  const stamp = Date.now();
  const email = `minunits-test-${stamp}@kifayat.local`;

  // ── Fixtures ──────────────────────────────────────────────────────────────
  const products = await Product.find({
    inStock: true,
    hidden: { $ne: true },
    deleted: { $ne: true },
    salePrice: { $gt: 0 },
  })
    .limit(2)
    .lean();

  if (products.length < 2) {
    console.error("Need 2 live products to run this test.");
    process.exit(1);
  }
  const [productA, productB] = products;

  const user = await User.create({
    name: "MinUnits Test User",
    email,
    gender: "Other",
    authProvider: "manual",
    isVerified: true,
    loyaltyPoints: 500,
  });
  created.users.push(user._id);

  console.log(`\nFixture: user ${email} (${user._id})`);
  console.log(`Fixture: product A = ${productA.name} (Rs ${productA.salePrice})`);
  console.log(`Fixture: product B = ${productB.name} (Rs ${productB.salePrice})\n`);

  // ── 1. Admin publishes a voucher with min_units = 2 ───────────────────────
  console.log("1) publish voucher with min_units = 2");
  {
    const req = mockReq(
      {
        discount_type: "percent",
        discount_percent: 10,
        product_quantity: 1,
        min_units: 2,
        points_required: 5,
        expires_at: "",
      },
      { _id: user._id, email },
    );
    const { res, captured } = mockRes();
    await voucherController.generateVoucher(req, res);
    check("publish returns 201", captured.status === 201, `got ${captured.status}`);
    check("voucher has min_units = 2", captured.payload?.voucher?.min_units === 2,
      `got ${captured.payload?.voucher?.min_units}`);
    if (captured.payload?.voucher) created.vouchers.push(captured.payload.voucher._id);
  }

  // ── 2. Invalid min_units is rejected ─────────────────────────────────────
  console.log("\n2) invalid min_units = 0 is rejected");
  {
    const req = mockReq(
      { discount_type: "percent", discount_percent: 10, product_quantity: 1, min_units: 0, points_required: 0 },
      { _id: user._id, email },
    );
    const { res, captured } = mockRes();
    await voucherController.generateVoucher(req, res);
    check("invalid min_units returns 400", captured.status === 400, `got ${captured.status}`);
    check("no voucher was created", !captured.payload?.voucher);
  }

  // ── 3. Customer buys it (real buy controller → snapshot) ─────────────────
  console.log("\n3) buy the voucher (snapshot must carry min_units)");
  let pvId = null;
  {
    const req = mockReq({ voucherId: String(created.vouchers[0]) }, user);
    const { res, captured } = mockRes();
    await voucherController.buyVoucher(req, res);
    check("buy returns 201", captured.status === 201, `got ${captured.status}`);
    const pv = captured.payload?.purchased;
    if (pv) {
      pvId = pv._id;
      created.purchased.push(pv._id);
    }
    check("purchased copy snapshots min_units = 2", pv?.min_units === 2, `got ${pv?.min_units}`);
    check("points were deducted", captured.payload?.remainingPoints === 495,
      `got ${captured.payload?.remainingPoints}`);
  }

  // ── 4. Summary exposes the unit rule ─────────────────────────────────────
  console.log("\n4) condition summary exposes the unit rule");
  {
    const pv = await PurchasedVoucher.findById(pvId).lean();
    const summary = voucherConditionSummary(pv);
    check("summary.minUnits = 2", summary.minUnits === 2, `got ${summary.minUnits}`);
    check("summary.unitRule is populated", /2\+ units/.test(summary.unitRule || ""), summary.unitRule);
  }

  // ── 5. Apply the voucher to product A ────────────────────────────────────
  console.log("\n5) apply the voucher to product A");
  {
    const req = mockReq({ purchasedVoucherId: String(pvId), productId: String(productA._id) }, user);
    const { res, captured } = mockRes();
    await voucherController.applyVoucher(req, res);
    check("apply succeeds", captured.payload?.success === true,
      JSON.stringify(captured.payload)?.slice(0, 160));
  }

  // ── 6. Checkout with 1 unit must be REJECTED ─────────────────────────────
  console.log("\n6) checkout with quantity 1 must be rejected");
  const shipping = {
    name: "MinUnits Test User",
    address: "Test Address, Karachi",
    shpType: "Regular",
    courierCompany: "TCS",
    courierCity: "Karachi",
    phoneNumber: "03000000099",
    phoneNumber2: "",
    shipping: "cod",
    orderConEmail: email,
  };
  {
    const req = mockReq(
      { items: [{ productId: String(productA._id), quantity: 1 }], shippingDetails: shipping },
      user,
    );
    const { res, captured } = mockRes();
    await orderController.placeOrder(req, res);
    check("rejected with 400", captured.status === 400, `got ${captured.status}`);
    check(
      "message explains the unit rule",
      /at least 2 units/i.test(captured.payload?.message || ""),
      captured.payload?.message,
    );
    const leaked = await Order.countDocuments({ user: user._id });
    check("no order was created", leaked === 0, `found ${leaked}`);
  }

  // ── 6b. The rejection must NOT drop the reservation ──────────────────────
  // A unit-rule "no" is fixable by editing the cart, so the voucher use has
  // to survive; otherwise the corrected retry silently bills full price.
  console.log("\n6b) the rejection leaves the voucher reservation intact");
  {
    const pv = await PurchasedVoucher.findById(pvId).lean();
    const entry = (pv?.applied_products || []).find(
      (a) => String(a.product) === String(productA._id),
    );
    check("product A is still reserved", entry?.status === "reserved", `got ${entry?.status}`);
  }

  // ── 7. Checkout with 2 units must SUCCEED + price correctly ─────────────
  console.log("\n7) checkout with quantity 2 must succeed at the discounted price");
  {
    const req = mockReq(
      { items: [{ productId: String(productA._id), quantity: 2 }], shippingDetails: shipping },
      user,
    );
    const { res, captured } = mockRes();
    await orderController.placeOrder(req, res);
    check("accepted with 201", captured.status === 201, `got ${captured.status} ${captured.payload?.message || ""}`);

    const order = captured.payload?.order;
    if (order?._id) created.orders.push(order._id);

    const expectedUnit = Math.round(productA.salePrice * 0.9);
    const expectedTotal = expectedUnit * 2;
    check(
      `total is 2 × Rs ${expectedUnit} = Rs ${expectedTotal}`,
      order?.totalAmount === expectedTotal,
      `got ${order?.totalAmount}`,
    );
  }

  // ── 8. Regression: a voucher with NO unit rule still works at qty 1 ─────
  console.log("\n8) control — voucher without a unit rule still applies at quantity 1");
  {
    // Publish + buy a plain voucher (no min_units at all → default 1).
    const reqPub = mockReq(
      { discount_type: "percent", discount_percent: 10, product_quantity: 1, points_required: 0 },
      { _id: user._id, email },
    );
    const pubRes = mockRes();
    await voucherController.generateVoucher(reqPub, pubRes.res);
    const plainVoucher = pubRes.captured.payload?.voucher;
    if (plainVoucher) created.vouchers.push(plainVoucher._id);
    check("plain voucher published", !!plainVoucher);
    check("plain voucher min_units defaults to 1", plainVoucher?.min_units === 1,
      `got ${plainVoucher?.min_units}`);

    const reqBuy = mockReq({ voucherId: String(plainVoucher._id) }, user);
    const buyRes = mockRes();
    await voucherController.buyVoucher(reqBuy, buyRes.res);
    const plainPv = buyRes.captured.payload?.purchased;
    if (plainPv) created.purchased.push(plainPv._id);
    check("plain purchased copy min_units = 1", plainPv?.min_units === 1, `got ${plainPv?.min_units}`);

    const reqApply = mockReq(
      { purchasedVoucherId: String(plainPv._id), productId: String(productB._id) },
      user,
    );
    const applyRes = mockRes();
    await voucherController.applyVoucher(reqApply, applyRes.res);
    check("plain voucher applies to product B", applyRes.captured.payload?.success === true);

    const reqOrder = mockReq(
      { items: [{ productId: String(productB._id), quantity: 1 }], shippingDetails: shipping },
      user,
    );
    const orderRes = mockRes();
    await orderController.placeOrder(reqOrder, orderRes.res);
    check(
      "quantity 1 accepted (no regression)",
      orderRes.captured.status === 201,
      `got ${orderRes.captured.status} ${orderRes.captured.payload?.message || ""}`,
    );
    const o = orderRes.captured.payload?.order;
    if (o?._id) created.orders.push(o._id);
    const expected = Math.round(productB.salePrice * 0.9);
    check(`total matches Rs ${expected}`, o?.totalAmount === expected, `got ${o?.totalAmount}`);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log("\ncleanup");
  await PreOrder.deleteMany({ user: { $in: created.users } });
  await ShippingDetail.deleteMany({ user: { $in: created.users } });
  await Order.deleteMany({ user: { $in: created.users } });
  await PurchasedVoucher.deleteMany({ user: { $in: created.users } });
  await DiscountVoucher.deleteMany({ _id: { $in: created.vouchers } });
  await User.deleteMany({ _id: { $in: created.users } });

  const leftovers =
    (await User.countDocuments({ _id: { $in: created.users } })) +
    (await Order.countDocuments({ user: { $in: created.users } })) +
    (await PreOrder.countDocuments({ user: { $in: created.users } })) +
    (await ShippingDetail.countDocuments({ user: { $in: created.users } })) +
    (await PurchasedVoucher.countDocuments({ user: { $in: created.users } })) +
    (await DiscountVoucher.countDocuments({ _id: { $in: created.vouchers } }));
  check("cleanup removed every fixture document", leftovers === 0, `${leftovers} left`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log("failures: " + failures.join(" | "));

  await mongoose.disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("TEST ERROR:", err.message);
  try {
    await PreOrder.deleteMany({ user: { $in: created.users } });
    await ShippingDetail.deleteMany({ user: { $in: created.users } });
    await Order.deleteMany({ user: { $in: created.users } });
    await PurchasedVoucher.deleteMany({ user: { $in: created.users } });
    await DiscountVoucher.deleteMany({ _id: { $in: created.vouchers } });
    await User.deleteMany({ _id: { $in: created.users } });
  } catch {}
  process.exit(1);
});
