require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const User = require("../models/User");

const COFOUNDER_EMAILS = [
  "asharkhanggc@gmail.com",
  "aaliyan12345ilf@gmail.com",
  "muhibkhan.dev@gmail.com",
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  for (const email of COFOUNDER_EMAILS) {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      if (user.role !== "admin") {
        user.role = "admin";
        await user.save();
        console.log(`Updated ${email} to role: admin`);
      } else {
        console.log(`${email} already has role: admin`);
      }
    } else {
      console.log(`User not found: ${email}`);
    }
  }

  await mongoose.disconnect();
  console.log("Done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});