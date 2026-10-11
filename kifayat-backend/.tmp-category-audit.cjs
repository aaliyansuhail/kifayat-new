// TEMP: audit live categories + how products are distributed across them.
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.log("No MONGODB_URI configured.");
    return;
  }
  console.log("connecting...");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log("connected:", mongoose.connection.name);

  const Category = require("./models/Category");
  const Product = require("./models/Product");

  const cats = await Category.find({}).sort({ name: 1 }).lean();
  console.log("\n=== Category collection (" + cats.length + ") ===");
  for (const c of cats) {
    const n = await Product.countDocuments({ category: c.slug });
    const nName = await Product.countDocuments({ category: c.name });
    console.log(`  ${String(c.name).padEnd(22)} slug=${String(c.slug).padEnd(22)} productCount=${String(c.productCount).padEnd(6)} bySlug=${n} byName=${nName}`);
  }

  const total = await Product.countDocuments({});
  console.log("\ntotal products:", total);

  const distinct = await Product.distinct("category");
  console.log("\n=== distinct Product.category values ===");
  for (const d of distinct) {
    const n = await Product.countDocuments({ category: d });
    console.log(`  ${JSON.stringify(d).padEnd(28)} ${n}`);
  }

  await mongoose.disconnect();
})().catch((e) => console.error("ERR:", e.message));
