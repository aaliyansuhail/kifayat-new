const mongoose = require("mongoose");
const User = require("../models/User");
require("dotenv").config();

const connectDB = require("../config/db");

async function checkSellerAccount() {
  try {
    await connectDB();

    const seller = await User.findOne({ email: "faiza@kifayat.co" }).lean();

    if (!seller) {
      console.log("❌ Seller account not found");
      process.exit(1);
    }

    console.log("✅ Seller account found:");
    console.log("Email:", seller.email);
    console.log("Name:", seller.name);
    console.log("Role:", seller.role);
    console.log("Is Verified:", seller.isVerified);
    console.log("Auth Provider:", seller.authProvider);
    console.log("Has Password:", !!seller.password);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

checkSellerAccount();
