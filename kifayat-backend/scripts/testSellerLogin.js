const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
require("dotenv").config();

const connectDB = require("../config/db");

async function testSellerLogin() {
  try {
    await connectDB();

    const email = "faiza@kifayat.co";
    const password = "faiza1234@kifayat.co";

    const user = await User.findOne({ email });

    if (!user) {
      console.log("❌ User not found");
      process.exit(1);
    }

    console.log("User found:");
    console.log("Email:", user.email);
    console.log("Role:", user.role);
    console.log("Auth Provider:", user.authProvider);
    console.log("Is Verified:", user.isVerified);

    if (user.authProvider === "google") {
      console.log("❌ This account was created with Google auth, not email/password");
      console.log("   Converting to email auth...");
      const hashedPassword = await bcrypt.hash(password, 12);
      user.authProvider = "email";
      user.password = hashedPassword;
      user.isVerified = true;
      await user.save();
      console.log("✅ Converted to email auth");
    }

    const match = await bcrypt.compare(password, user.password);
    console.log("Password match:", match);

    if (!match) {
      console.log("❌ Password does not match. Resetting...");
      const hashedPassword = await bcrypt.hash(password, 12);
      user.password = hashedPassword;
      await user.save();
      console.log("✅ Password reset");
    }

    console.log("✅ Login should work now");

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

testSellerLogin();
