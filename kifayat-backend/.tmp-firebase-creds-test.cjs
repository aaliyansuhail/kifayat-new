// TEMP: prove whether the backend's Firebase Admin credentials really work.
require("dotenv").config();
require("./config/firebaseAdmin"); // initializes the admin app
const { getAuth } = require("firebase-admin/auth");

(async () => {
  try {
    // Calls Identity Toolkit over HTTP with an OAuth token minted from the
    // service account key — so this fails loudly if the key is wrong/rotated.
    const res = await getAuth().listUsers(1);
    console.log("AUTH CREDENTIALS OK — listUsers returned", res.users.length, "user(s)");
  } catch (err) {
    console.log("AUTH CREDENTIALS FAILED");
    console.log("  code   :", err.code);
    console.log("  message:", err.message);
  }
})();
