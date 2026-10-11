const DefectiveProductReport = require("../models/DefectiveProductReport");
const Product = require("../models/Product");
const UserFinalData = require("../models/UserFinalData");
const ShipmentRecord = require("../models/ShipmentRecord");
const fs = require("fs");
const path = require("path");

const uploadsDir = path.join(__dirname, "..", "uploads", "defective");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/**
 * Work out how to reach the signed-in customer.
 *
 * The account profile is authoritative; only when it has no phone do we fall
 * back to the shipping details captured with their orders (users_final_data),
 * and finally to the most recent confirmed shipment. This means the admin
 * panel always has a real phone number even though the form does not ask for
 * one.
 *
 * @returns {Promise<{name: string, email: string, phone: string}>}
 */
async function resolveUserContact(user) {
  const accountEmail = String(user.email || "").trim().toLowerCase();
  const contact = {
    name: String(user.name || "").trim(),
    email: accountEmail,
    phone: String(user.phone || "").trim(),
  };

  if (contact.phone) return contact;

  const ownerOrEmail = (email) => {
    const clauses = [{ user: user._id }];
    if (email) clauses.push({ email });
    return { $or: clauses };
  };

  const finalData = await UserFinalData.findOne(ownerOrEmail(accountEmail))
    .select("shippingName shippingPhone shippingEmail")
    .lean();

  if (finalData) {
    if (!contact.name && finalData.shippingName) contact.name = finalData.shippingName;
    if (!contact.email && finalData.shippingEmail) contact.email = finalData.shippingEmail;
    if (finalData.shippingPhone) contact.phone = String(finalData.shippingPhone).trim();
  }

  if (contact.phone) return contact;

  const shipmentClauses = [{ user: user._id }];
  if (accountEmail) shipmentClauses.push({ userEmail: accountEmail });
  const shipment = await ShipmentRecord.findOne({ $or: shipmentClauses })
    .sort({ createdAt: -1 })
    .select("name phoneNumber")
    .lean();

  if (shipment) {
    if (!contact.name && shipment.name) contact.name = shipment.name;
    if (shipment.phoneNumber) contact.phone = String(shipment.phoneNumber).trim();
  }

  return contact;
}

// ── GET /api/defective-products/contact  (authenticated user) ────────────────
// Lets the account form show exactly the email/phone that will be attached to
// the report, including the shipment fallback.
exports.getMyContact = async (req, res) => {
  try {
    const contact = await resolveUserContact(req.user);
    return res.json({ success: true, contact });
  } catch (err) {
    console.error("Get defective contact error:", err);
    return res.status(500).json({ success: false, message: "Failed to load contact details." });
  }
};

// multer has already streamed these files to disk before the handler runs, so a
// rejected report must clean them up itself — otherwise every failed attempt
// leaks images/videos into uploads/defective forever.
function discardUploads(files) {
  if (!files) return;
  for (const list of Object.values(files)) {
    for (const f of list || []) {
      try {
        fs.unlinkSync(f.path);
      } catch {
        // Already gone — nothing to clean up.
      }
    }
  }
}

exports.submitReport = async (req, res) => {
  try {
    const { name, email, phone, productId, productName, productSku, description } = req.body;

    if (!description || !description.trim()) {
      discardUploads(req.files);
      return res.status(400).json({ success: false, message: "Description is required." });
    }

    const images = [];
    const videos = [];

    if (req.files) {
      if (req.files.images) {
        for (const f of req.files.images) {
          images.push(`/uploads/defective/${f.filename}`);
        }
      }
      if (req.files.videos) {
        for (const f of req.files.videos) {
          videos.push(`/uploads/defective/${f.filename}`);
        }
      }
    }

    if (images.length < 2) {
      discardUploads(req.files);
      return res.status(400).json({ success: false, message: "At least 2 photos are required." });
    }
    if (videos.length < 1) {
      discardUploads(req.files);
      return res.status(400).json({ success: false, message: "Video Should Cover Complete Unboxing of the Products otherwise the request will not be entertained Thanks -Kifayat" });
    }

    let productRef = { id: null, name: productName || "", sku: productSku || "" };
    if (productId) {
      const p = await Product.findById(productId).select("name sku").lean();
      if (p) {
        productRef = { id: p._id, name: p.name, sku: p.sku || "" };
      }
    }

    // Signed-in reports use the account's own contact details (falling back to
    // the shipping details on past orders), so the customer stays reachable even
    // if the form fields were blank or tampered with.
    let contact = {
      name: String(name || "").trim(),
      email: String(email || "").trim().toLowerCase(),
      phone: String(phone || "").trim(),
    };
    if (req.user) {
      const resolved = await resolveUserContact(req.user);
      contact = {
        name: resolved.name || contact.name,
        email: resolved.email || contact.email,
        phone: resolved.phone || contact.phone,
      };
    }

    const report = await DefectiveProductReport.create({
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      user: req.user?._id || null,
      product: productRef,
      description: description.trim(),
      images,
      videos,
    });

    res.status(201).json({ success: true, report });
  } catch (err) {
    console.error("Submit defective report error:", err);
    // Never leave the uploaded media behind when the report was not stored.
    discardUploads(req.files);
    res.status(500).json({ success: false, message: "Failed to submit report." });
  }
};

exports.getReports = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const total = await DefectiveProductReport.countDocuments(filter);
    const reports = await DefectiveProductReport.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .populate("user", "name email avatar")
      .lean();

    res.json({ success: true, reports, total, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Get defective reports error:", err);
    res.status(500).json({ success: false, message: "Failed to load reports." });
  }
};

exports.getReportById = async (req, res) => {
  try {
    const report = await DefectiveProductReport.findById(req.params.id)
      .populate("user", "name email avatar")
      .lean();
    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }
    res.json({ success: true, report });
  } catch (err) {
    console.error("Get defective report error:", err);
    res.status(500).json({ success: false, message: "Failed to load report." });
  }
};

exports.updateReportStatus = async (req, res) => {
  try {
    const { status, adminNote } = req.body;
    const report = await DefectiveProductReport.findByIdAndUpdate(
      req.params.id,
      { status, adminNote },
      { new: true, runValidators: true }
    );
    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }
    res.json({ success: true, report });
  } catch (err) {
    console.error("Update defective report error:", err);
    res.status(500).json({ success: false, message: "Failed to update report." });
  }
};

// ---------------------------------------------------------------------------
// Chat: Send a message on a defective product report
// ---------------------------------------------------------------------------
exports.sendChatMessage = async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: "Message is required." });
    }

    const report = await DefectiveProductReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }

    // Only the report owner or an admin can chat
    const isOwner = report.user && String(report.user) === String(req.user._id);
    if (!isOwner && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    const sender = req.user.role === "admin" ? "admin" : "user";

    report.chat.push({
      sender,
      message: message.trim(),
      senderId: req.user._id,
    });

    await report.save();

    console.log(`[DefectiveChat] ${sender} ${req.user.email} sent message on report ${req.params.id}`);

    // Emit socket event for real-time delivery
    const io = req.app.get("io");
    if (io) {
      io.to(`defective-${req.params.id}`).emit("chat:message", {
        sender,
        message: message.trim(),
        senderId: req.user._id,
        createdAt: new Date(),
      });
    }

    res.json({ success: true, chat: report.chat });
  } catch (err) {
    console.error("Send chat message error:", err);
    res.status(500).json({ success: false, message: "Failed to send message." });
  }
};

// ---------------------------------------------------------------------------
// Chat: Get all messages for a defective product report
// ---------------------------------------------------------------------------
exports.getChatMessages = async (req, res) => {
  try {
    const report = await DefectiveProductReport.findById(req.params.id)
      .select("chat user")
      .lean();

    if (!report) {
      return res.status(404).json({ success: false, message: "Report not found." });
    }

    // Only the report owner or an admin can read chat
    const isOwner = report.user && String(report.user) === String(req.user._id);
    if (!isOwner && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Not authorized." });
    }

    res.json({ success: true, chat: report.chat });
  } catch (err) {
    console.error("Get chat messages error:", err);
    res.status(500).json({ success: false, message: "Failed to load messages." });
  }
};
