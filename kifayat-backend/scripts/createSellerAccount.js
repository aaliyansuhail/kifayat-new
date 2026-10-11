const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
require("dotenv").config();

const connectDB = require("../config/db");

async function createSellerAccount() {
  try {
    await connectDB();

    const sellerData = {
      name: "Seller",
      email: "faiza@kifayat.co",
      password: "faiza1234@kifayat.co",
      gender: "Female",
      role: "seller",
      authProvider: "email",
      isVerified: true,
    };

    // Check if user already exists
    const existingUser = await User.findOne({ email: sellerData.email });
    if (existingUser) {
      console.log("User with this email already exists. Updating role to seller...");
      existingUser.role = "seller";
      existingUser.isVerified = true;
      await existingUser.save();
      console.log("✅ Seller account updated successfully!");
      process.exit(0);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(sellerData.password, 12);

    // Create seller
    const seller = await User.create({
      name: sellerData.name,
      email: sellerData.email,
      password: hashedPassword,
      gender: sellerData.gender,
      role: sellerData.role,
      authProvider: sellerData.authProvider,
      isVerified: sellerData.isVerified,
    });

    console.log("✅ Seller account created successfully!");
    console.log("Email:", seller.email);
    console.log("Password:", sellerData.password);
    console.log("Role:", seller.role);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating seller account:", error);
    process.exit(1);
  }
}

createSellerAccount();
