const mongoose = require("mongoose");
const User = require("../models/User");
const BlockedUser = require("../models/BlockedUser");
const DeletedUser = require("../models/DeletedUser");
require("dotenv").config();

const connectDB = require("../config/db");

async function checkBlockedStatus() {
  try {
    await connectDB();

    const email = "faiza@kifayat.co";

    const user = await User.findOne({ email }).lean();
    console.log("User status:");
    console.log("Email:", user?.email);
    console.log("Role:", user?.role);
    console.log("Is Verified:", user?.isVerified);

    const blocked = await BlockedUser.findOne({ email }).lean();
    console.log("\nBlocked status:", blocked ? "BLOCKED" : "Not blocked");
    if (blocked) console.log("Block reason:", blocked.message);

    const deleted = await DeletedUser.findOne({ email }).lean();
    console.log("Deleted status:", deleted ? "DELETED" : "Not deleted");
    if (deleted) console.log("Delete reason:", deleted.message);

    if (!blocked && !deleted) {
      console.log("\n✅ Account is not blocked or deleted");
    } else {
      console.log("\n❌ Account has restrictions");
    }

    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

checkBlockedStatus();
