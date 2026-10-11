/**
 * Attribute a sample of catalogue products to a seller so the seller dashboard
 * and its click/hover/view analytics have real data.
 *
 * Usage: node scripts/assignSellerProducts.js [sellerEmail] [count]
 * Safe to re-run: it only writes sellerId onto products that have none.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Product = require("../models/Product");
const User = require("../models/User");

const EMAIL = process.argv[2] || "faiza@kifayat.co";
const COUNT = Number(process.argv[3]) || 24;

(async () => {
  await connectDB();

  const seller = await User.findOne({ email: EMAIL.toLowerCase() });
  if (!seller) {
    console.error(`seller not found: ${EMAIL}`);
    process.exit(1);
  }
  if (seller.role !== "seller") {
    console.error(`${EMAIL} has role "${seller.role}", not "seller"`);
    process.exit(1);
  }
  console.log(`seller: ${seller.email} (${seller._id})`);

  // In-stock, visible, not already owned by another seller.
  const candidates = await Product.find({
    sellerId: null,
    deleted: { $ne: true },
    hidden: { $ne: true },
    stock: { $gt: 0 },
  })
    .sort({ salesCount: -1, createdAt: -1 })
    .limit(COUNT)
    .select("_id name salePrice stock salesCount")
    .lean();

  if (candidates.length === 0) {
    console.log("no unassigned products available");
    await mongoose.disconnect();
    process.exit(0);
  }

  const ids = candidates.map((p) => p._id);
  const res = await Product.updateMany(
    { _id: { $in: ids } },
    { $set: { sellerId: seller._id } },
  );

  console.log(`assigned ${res.modifiedCount} product(s):`);
  candidates.forEach((p) =>
    console.log(`  • ${p.name} — Rs ${p.salePrice} (stock ${p.stock}, sold ${p.salesCount ?? 0})`),
  );

  console.log(
    "\nseller total now:",
    await Product.countDocuments({ sellerId: seller._id, deleted: { $ne: true } }),
  );
  await mongoose.disconnect();
  process.exit(0);
})();
