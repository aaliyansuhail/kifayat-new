const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
require("dotenv").config();

const connectDB = require("../config/db");

async function createAdminAccount() {
  try {
    await connectDB();

    const adminData = {
      name: "Admin",
      email: "cofounder@kifayat.co",
      password: "cofounder@kifayat.pk",
      gender: "Male",
      role: "admin",
      authProvider: "email",
      isVerified: true,
    };

    // Check if user already exists
    const existingUser = await User.findOne({ email: adminData.email });
    if (existingUser) {
      console.log("User with this email already exists. Updating role to admin...");
      existingUser.role = "admin";
      existingUser.isVerified = true;
      await existingUser.save();
      console.log("✅ Admin account updated successfully!");
      process.exit(0);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(adminData.password, 12);

    // Create admin
    const admin = await User.create({
      name: adminData.name,
      email: adminData.email,
      password: hashedPassword,
      gender: adminData.gender,
      role: adminData.role,
      authProvider: adminData.authProvider,
      isVerified: adminData.isVerified,
    });

    console.log("✅ Admin account created successfully!");
    console.log("Email:", admin.email);
    console.log("Password:", adminData.password);
    console.log("Role:", admin.role);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error creating admin account:", error);
    process.exit(1);
  }
}

createAdminAccount();
