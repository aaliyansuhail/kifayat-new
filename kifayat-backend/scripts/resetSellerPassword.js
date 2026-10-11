const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
require("dotenv").config();

const connectDB = require("../config/db");

async function resetSellerPassword() {
  try {
    await connectDB();

    const seller = await User.findOne({ email: "faiza@kifayat.co" });

    if (!seller) {
      console.log("❌ Seller account not found");
      process.exit(1);
    }

    const newPassword = "faiza1234@kifayat.co";
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    seller.password = hashedPassword;
    seller.isVerified = true;
    seller.role = "seller";
    await seller.save();

    console.log("✅ Seller password reset successfully!");
    console.log("Email:", seller.email);
    console.log("Password:", newPassword);
    console.log("Role:", seller.role);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

resetSellerPassword();
