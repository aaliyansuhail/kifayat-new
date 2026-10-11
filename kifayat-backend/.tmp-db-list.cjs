// TEMP: list all databases on the Atlas cluster and their collection counts.
require("dotenv").config();
const { MongoClient } = require("mongodb");

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const admin = client.db().admin();
  const { databases } = await admin.listDatabases();
  for (const d of databases) {
    if (["admin", "local", "config"].includes(d.name)) continue;
    const db = client.db(d.name);
    const cols = await db.listCollections().toArray();
    let products = 0, orders = 0, users = 0;
    try { products = await db.collection("products").countDocuments(); } catch {}
    try { orders = await db.collection("orders").countDocuments(); } catch {}
    try { users = await db.collection("users").countDocuments(); } catch {}
    console.log(`${d.name.padEnd(24)} sizeMB=${String((d.sizeOnDisk/1048576).toFixed(2)).padEnd(9)} collections=${String(cols.length).padEnd(4)} products=${String(products).padEnd(6)} orders=${String(orders).padEnd(6)} users=${users}`);
  }
  await client.close();
})().catch((e) => console.error("ERR:", e.message));
