const Groq     = require("groq-sdk");
const Settings = require("../models/Settings");
const { sendTestEmail, getEmailDiagnostics } = require("../utils/email");
const { resolveHeroProduct } = require("../utils/heroObjects");

const GROQ_TEST_MODEL = "llama-3.3-70b-versatile";

function maskKey(key) {
  if (!key) return null;
  return `${key.slice(0, 6)}${"•".repeat(Math.max(0, key.length - 10))}${key.slice(-4)}`;
}

async function pingGroq(apiKey) {
  const groq = new Groq({ apiKey });
  const rsp  = await groq.chat.completions.create({
    model:    GROQ_TEST_MODEL,
    messages: [{ role: "user", content: 'Reply with exactly one word: "OK"' }],
    max_tokens: 5, temperature: 0,
  });
  return (rsp.choices[0]?.message?.content || "").trim();
}

// ─── GET /api/admin/settings ─────────────────────────────────────────────────
const getAdminSettings = async (req, res) => {
  try {
    const s = await Settings.findOne({}).lean();
    const keys = (s?.groqApiKeys || []).map((k) => ({
      id:      k._id ? k._id.toString() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label:   k.label,
      task:    k.task,
      preview: maskKey(k.key),
    }));

    // Legacy compat
    const legacyRaw = s?.groqApiKey || process.env.GROQ_API_KEY || "";
    const groqKey   = {
      configured: keys.length > 0 || !!legacyRaw,
      preview:    keys.length > 0 ? null : maskKey(legacyRaw),
    };

    res.json({
      success: true,
      settings: {
        groqKeys: keys,
      groqKey,
      deliveryFee: Number.isFinite(Number(s?.deliveryFee)) ? Number(s.deliveryFee) : 100,
    },
  });
  } catch (err) {
    console.error("getAdminSettings error:", err);
    res.status(500).json({ success: false, message: "Failed to load settings." });
  }
};

const updateDeliveryFee = async (req, res) => {
  try {
    const { deliveryFee } = req.body;
    if (deliveryFee === undefined || deliveryFee === null) {
      return res.status(400).json({ success: false, message: "deliveryFee is required." });
    }
    const fee = Number(deliveryFee);
    if (!Number.isFinite(fee) || fee < 0) {
      return res.status(400).json({ success: false, message: "deliveryFee must be a non-negative number." });
    }
    const s = await Settings.findOneAndUpdate(
      {},
      { $set: { deliveryFee: fee } },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: "Delivery fee saved.", deliveryFee: s.deliveryFee });
  } catch (err) {
    console.error("updateDeliveryFee error:", err);
    res.status(500).json({ success: false, message: "Failed to save delivery fee." });
  }
};

// ─── PUT /api/admin/settings/hero-objects ─── set the landing hero diptych ───
const updateHeroObjects = async (req, res) => {
  try {
    const { left, right } = req.body ?? {};
    if (left !== null && left !== undefined && typeof left !== "string") {
      return res.status(400).json({ success: false, message: "left must be a product id string." });
    }
    if (right !== null && right !== undefined && typeof right !== "string") {
      return res.status(400).json({ success: false, message: "right must be a product id string." });
    }
    // Validate before saving: a hero slot must point at a product that actually
    // exists and is live, otherwise the storefront fetches a 404 on the
    // homepage for every visitor. Accepts the Mongo id, the public productId
    // (kp-00000000001) or the slug — all are stored as the canonical Mongo id.
    const wanted = { left: left ? left.trim() : null, right: right ? right.trim() : null };
    const heroObjects = { left: null, right: null };
    for (const slot of ["left", "right"]) {
      const value = wanted[slot];
      if (!value) continue;
      const resolved = await resolveHeroProduct(value);
      if (!resolved.ok) {
        return res.status(400).json({
          success: false,
          message:
            resolved.reason === "not_live"
              ? `The product for the ${slot} hero slot is hidden or deleted. Choose a live product.`
              : `No product matches the ${slot} hero id "${value}". Choose a product from Product Hunting.`,
        });
      }
      heroObjects[slot] = String(resolved.product._id);
    }

    const s = await Settings.findOneAndUpdate(
      {},
      { $set: { heroObjects } },
      { upsert: true, new: true }
    );
    res.json({
      success: true,
      message: "Hero objects saved.",
      heroObjects: {
        left: s.heroObjects?.left ?? null,
        right: s.heroObjects?.right ?? null,
      },
    });
  } catch (err) {
    console.error("updateHeroObjects error:", err);
    res.status(500).json({ success: false, message: "Failed to save hero objects." });
  }
};

// ─── POST /api/admin/settings/email-test ─────────────────────────────────────
// Proves transactional email actually delivers, instead of only reporting that
// a provider is configured. Sends to the requesting admin's OWN address — the
// recipient is never taken from the request body, so this cannot be abused as
// an open relay.
const sendEmailTest = async (req, res) => {
  try {
    const diagnostics = getEmailDiagnostics();
    const to = String(req.user?.email || "").trim().toLowerCase();
    if (!to) {
      return res.status(400).json({ success: false, message: "Your account has no email address." });
    }

    const result = await sendTestEmail(to);
    return res.status(result.ok ? 200 : 502).json({
      success: result.ok,
      message: result.detail,
      provider: result.provider,
      to,
      diagnostics,
    });
  } catch (err) {
    console.error("sendEmailTest error:", err);
    return res.status(500).json({ success: false, message: "Failed to run the email test." });
  }
};

// ─── POST /api/admin/settings/groq-keys — add a new key ──────────────────────
const addGroqKey = async (req, res) => {
  try {
    const { key, label = "API Key", task = "default" } = req.body;
    if (!key || typeof key !== "string" || key.trim().length < 8)
      return res.status(400).json({ success: false, message: "Invalid API key." });

    await Settings.findOneAndUpdate(
      {},
      { $push: { groqApiKeys: { key: key.trim(), label: label.trim() || "API Key", task } } },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: "Key added." });
  } catch (err) {
    console.error("addGroqKey error:", err);
    res.status(500).json({ success: false, message: "Failed to add key." });
  }
};

// ─── PUT /api/admin/settings/groq-keys/:id — update label / task ─────────────
const updateGroqKeyById = async (req, res) => {
  try {
    const { id } = req.params;
    const { label, task } = req.body;
    await Settings.findOneAndUpdate(
      { "groqApiKeys._id": id },
      {
        $set: {
          ...(label !== undefined && { "groqApiKeys.$.label": label }),
          ...(task  !== undefined && { "groqApiKeys.$.task":  task  }),
        },
      }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("updateGroqKeyById error:", err);
    res.status(500).json({ success: false, message: "Failed to update key." });
  }
};

// ─── DELETE /api/admin/settings/groq-keys/:id ────────────────────────────────
const deleteGroqKeyById = async (req, res) => {
  try {
    const { id } = req.params;
    await Settings.findOneAndUpdate({}, { $pull: { groqApiKeys: { _id: id } } });
    res.json({ success: true, message: "Key removed." });
  } catch (err) {
    console.error("deleteGroqKeyById error:", err);
    res.status(500).json({ success: false, message: "Failed to remove key." });
  }
};

// ─── POST /api/admin/settings/groq-keys/:id/test ─────────────────────────────
const testGroqKeyById = async (req, res) => {
  try {
    const { id } = req.params;
    const s   = await Settings.findOne({}).lean();
    const entry = (s?.groqApiKeys || []).find((k) => k._id.toString() === id);
    if (!entry) return res.status(404).json({ success: false, message: "Key not found." });

    const reply = await pingGroq(entry.key);
    res.json({ success: true, message: `Connection OK — model replied: ${reply}` });
  } catch (err) {
    console.error("testGroqKeyById error:", err);
    res.status(400).json({ success: false, message: "Connection failed." });
  }
};

// ─── Legacy endpoints (kept for backward-compat) ─────────────────────────────
const updateGroqKey = async (req, res) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== "string" || key.trim().length < 8)
      return res.status(400).json({ success: false, message: "Invalid API key." });
    await Settings.findOneAndUpdate({}, { $set: { groqApiKey: key.trim() } }, { upsert: true });
    res.json({ success: true, message: "Groq API key saved." });
  } catch (err) {
    console.error("updateGroqKey error:", err);
    res.status(500).json({ success: false, message: "Failed to save key." });
  }
};

const deleteGroqKey = async (req, res) => {
  try {
    await Settings.findOneAndUpdate({}, { $unset: { groqApiKey: "" } }, { upsert: true });
    res.json({ success: true, message: "Groq API key removed." });
  } catch (err) {
    console.error("deleteGroqKey error:", err);
    res.status(500).json({ success: false, message: "Failed to remove key." });
  }
};

const testGroqKey = async (req, res) => {
  try {
    let apiKey = (req.body?.key || "").trim();
    if (!apiKey) {
      const s = await Settings.findOne({}).lean();
      const keys = s?.groqApiKeys || [];
      apiKey = keys.find((k) => k.task === "default")?.key
            || keys[0]?.key
            || s?.groqApiKey
            || process.env.GROQ_API_KEY
            || "";
    }
    if (!apiKey) return res.status(400).json({ success: false, message: "No Groq API key configured." });
    const reply = await pingGroq(apiKey);
    res.json({ success: true, message: `Connection successful — model replied: ${reply}` });
  } catch (err) {
    console.error("testGroqKey error:", err);
    res.status(400).json({ success: false, message: "Connection failed." });
  }
};

module.exports = {
  getAdminSettings,
  sendEmailTest,
  addGroqKey,
  updateGroqKeyById,
  deleteGroqKeyById,
  testGroqKeyById,
  updateDeliveryFee,
  updateHeroObjects,
  // legacy
  updateGroqKey,
  deleteGroqKey,
  testGroqKey,
};
