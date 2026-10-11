const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const ShippingDetail = require("../models/ShippingDetail");
const ShipmentRecord = require("../models/ShipmentRecord");
const PreOrder = require("../models/PreOrder");
const CancelledOrders = require("../models/CancelledOrders");
const Product = require("../models/Product");
const { logActivity, ACTIONS } = require("../utils/activityLogger");
const { generateOTP, hashOTP, safeEqual, getOTPExpiry, isOTPExpired, storeOTP, findOTP, consumeOTP } = require("../utils/otp");
const { sendOTPEmail, sendOrderConfirmationEmail, sendOrderConfirmationLinkEmail, sendLateConfirmationEmail, sendAdminStockAlertEmail } = require("../utils/email");
const LateConfirmationOrder = require("../models/LateConfirmationOrder");
const { productAvailability } = require("./productController");
const { applyVoucherDiscount, productSatisfiesVoucher } = require("../utils/voucherRules");
const PurchasedVoucher = require("../models/PurchasedVoucher");
const {
  convertReservationsToConsumed,
  releaseClaimedUses,
  restoreOrderVoucherUses,
  releaseReservedForProducts,
} = require("../utils/voucherLifecycle");
const Joi = require("joi");

// In-memory per-address throttle for order confirmation link emails. The
// confirmation email address is user-controlled and not OTP-gated at checkout,
// so an attacker could otherwise use the order endpoint as a mail bomb.
const orderConEmailCooldowns = new Map(); // email -> lastSentAt (ms)
const ORDER_CON_EMAIL_COOLDOWN_MS = 60 * 1000;

function checkOrderConEmailCooldown(email) {
  const lastSentAt = orderConEmailCooldowns.get(email);
  if (!lastSentAt) return 0;
  const elapsed = Date.now() - lastSentAt;
  if (elapsed >= ORDER_CON_EMAIL_COOLDOWN_MS) {
    orderConEmailCooldowns.delete(email);
    return 0;
  }
  return Math.ceil((ORDER_CON_EMAIL_COOLDOWN_MS - elapsed) / 1000);
}

function recordOrderConEmailSent(email) {
  orderConEmailCooldowns.set(email, Date.now());
}

function getRequestBaseUrl(req) {
  const origin = req.get("origin");
  if (origin) return origin;

  const forwardedProto = String(req.get("x-forwarded-proto") || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.get("x-forwarded-host") || "")
    .split(",")[0]
    .trim();
  // Do not use req.host here: when the API is reached directly in local
  // development it is the backend port, not the frontend port.
  if (!forwardedHost) return "";

  const protocol = forwardedProto || "https";
  return `${protocol}://${forwardedHost}`;
}

/**
 * Normalized item shape for the late-confirmation archive — carries the
 * variation/product ids so the archived data stays fully reconstructable.
 */
function normalizeLateOrderItems(items = []) {
  return items.map((item) => ({
    product: item.product?._id || item.product,
    name: item.name || item.product?.name || "",
    price: item.price ?? item.product?.salePrice ?? 0,
    quantity: item.quantity || 0,
    imageUrl: item.imageUrl || item.product?.imageUrl || "",
    variation: item.variation || "",
    productId: item.productId || "",
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the numbered product/variation/qty fields for a shipment record.
//
// A shipment record stores one document per confirmed order with numbered
// columns: product1/productName1/productSku1/productPrice1/variationName1/qty1…
// The public product id (kp-00000000001) is what ties a line back to the
// catalogue; names/skus/prices are denormalized so the record stays readable
// even if the product is later edited or deleted.
// ─────────────────────────────────────────────────────────────────────────────
async function buildShipmentProductFields(items = []) {
  const list = Array.isArray(items) ? items : [];

  const refs = [];
  for (const item of list) {
    const ref = item?.product?._id || item?.product;
    if (ref) refs.push(ref);
  }

  let productsById = new Map();
  if (refs.length > 0) {
    const docs = await Product.find({ _id: { $in: refs } })
      .select("_id name sku productId imageUrl salePrice")
      .lean();
    productsById = new Map(docs.map((p) => [String(p._id), p]));
  }

  const productFields = {};
  const productExtras = {};
  const productSearch = [];
  const resolvedItems = [];

  list.forEach((item, idx) => {
    const i = idx + 1;
    const ref = item?.product?._id || item?.product;
    const product = ref ? productsById.get(String(ref)) : null;
    const name = String(product?.name || item?.name || "").trim();
    const sku = String(product?.sku || item?.sku || "").trim();
    const publicId = String(product?.productId || item?.productId || "").trim();
    const variation = String(item?.variation || item?.variationName || "").trim();
    const quantity = Number(item?.quantity) || 0;
    const unitPrice = Number(item?.price ?? product?.salePrice ?? 0) || 0;

    productFields[`product${i}`] = publicId;
    productFields[`variation${i}`] = variation;
    productFields[`qty${i}`] = quantity;

    productExtras[`productSku${i}`] = sku;
    productExtras[`variationName${i}`] = variation;
    productExtras[`productName${i}`] = name;
    productExtras[`productPrice${i}`] = unitPrice;

    if (sku) productSearch.push(sku.toLowerCase());
    if (publicId) productSearch.push(publicId.toLowerCase());
    if (name) productSearch.push(name.toLowerCase());

    resolvedItems.push({
      product: product || null,
      publicId,
      variation,
      sku,
      name,
      quantity,
      unitPrice,
      productRef: ref || null,
    });
  });

  return { productFields, productExtras, productSearch, resolvedItems };
}

/**
 * Move a confirmed order into the two records used by the shipment workflow.
 *
 * Both the customer email confirmation and the admin finalization use this
 * helper so they cannot drift in which fields they save or which collections
 * they touch. The upsert/duplicate guards make a retry safe.
 */
async function createConfirmedOrderExports({
  user,
  order,
  items = [],
  shipmentItems = items,
  totalAmount = 0,
  shipping,
}) {
  const orderId = order?._id?.toString?.() || order?.toString?.() || String(order);
  const { productFields, productExtras, productSearch, resolvedItems } =
    await buildShipmentProductFields(shipmentItems);

  const normalizedItems = items.map((item, idx) => {
    const r = resolvedItems[idx] || {};
    return {
      product: item.product?._id || item.product,
      name: r.name || item.name || item.product?.name || "",
      price: item.price ?? item.product?.salePrice ?? 0,
      quantity: item.quantity || 0,
      imageUrl: item.imageUrl || item.product?.imageUrl || "",
      variation: r.variation || item.variation || "",
      productId: r.publicId || item.productId || "",
    };
  });

  const preOrderPayload = {
    user,
    order: orderId,
    items: normalizedItems,
    totalAmount,
    status: "confirmed",
    name: shipping.name || "",
    address: shipping.address || "",
    shpType: shipping.shpType || "Regular",
    courierCompany: shipping.courierCompany || "",
    courierCity: shipping.courierCity || "",
    phoneNumber: shipping.phoneNumber || "",
    phoneNumber2: shipping.phoneNumber2 || "",
    sellPrice: shipping.sellPrice ?? totalAmount,
    businessProfiles: shipping.businessProfiles ?? 1,
    courierInstruction: shipping.courierInstruction || "",
    email: shipping.email || "",
    shipping: shipping.shipping || "cod",
    allowToOpen: shipping.allowToOpen || "",
    latitude: shipping.latitude ?? null,
    longitude: shipping.longitude ?? null,
    finalized: true,
  };

  let preOrder;
  try {
    preOrder = await PreOrder.findOneAndUpdate(
      { order: orderId },
      { $set: preOrderPayload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    // A concurrent retry inserted the same order between find and upsert.
    preOrder = await PreOrder.findOne({ order: orderId });
    if (!preOrder) throw err;
  }

  const shipmentPayload = {
    orderID: orderId,
    name: shipping.name || "",
    address: shipping.address || "",
    shpType: shipping.shpType || "Regular",
    courierCompany: shipping.courierCompany || "",
    courierCity: shipping.courierCity || "",
    phoneNumber: shipping.phoneNumber || "",
    phoneNumber2: shipping.phoneNumber2 || "",
    sellPrice: shipping.sellPrice ?? totalAmount,
    businessProfiles: shipping.businessProfiles ?? 1,
    courierInstruction: shipping.courierInstruction || "",
    productCount: shipmentItems.length,
    productSearch,
    ...productFields,
    ...productExtras,
    shipping: shipping.shipping || "cod",
    allowToOpen: shipping.allowToOpen || "",
    latitude: shipping.latitude ?? null,
    longitude: shipping.longitude ?? null,
    // Customer/user reference — kept on the shipment record so the admin
    // "Shipment Details" page can show exactly who placed the order.
    user: user || null,
    userEmail: (shipping.email || "").trim().toLowerCase() || "",
  };

  let shipmentRecord;
  try {
    shipmentRecord = await ShipmentRecord.findOneAndUpdate(
      { orderID: orderId },
      { $set: shipmentPayload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    // A concurrent retry inserted the same order between find and upsert.
    shipmentRecord = await ShipmentRecord.findOne({ orderID: orderId });
    if (!shipmentRecord) throw err;
  }

  return { preOrder, shipmentRecord };
}

// Shipping email OTPs are stored in MongoDB (see utils/otp.js storeOTP/consumeOTP).

// PreOrder confirmation timers — indexed by PreOrder _id string
const preOrderTimers = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/shipping-otp  — send OTP to confirmation email
// Body: { email, name }
// ─────────────────────────────────────────────────────────────────────────────
const sendShippingOTP = async (req, res) => {
  try {
    const { email, name } = req.body;
    const userId = req.user._id.toString();
    
    const schema = Joi.object({
      email: Joi.string().email().lowercase().required(),
      name: Joi.string().min(2).required(),
    });
    
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    
    const otp = generateOTP();
    const hashedOtp = hashOTP(otp);
    const expiry = getOTPExpiry();
    const storeKey = `${userId}-${email}`;
    
    await storeOTP(storeKey, "shipping-email", hashedOtp, expiry);
    
    try {
      await sendOTPEmail(email, name, otp);
    } catch (emailErr) {
      await consumeOTP(storeKey);
      console.error("Failed to send shipping OTP email:", emailErr);
      return res.status(500).json({ success: false, message: "Failed to send verification email." });
    }
    
    return res.status(200).json({ 
      success: true, 
      message: "Verification code sent to your email!" 
    });
    
  } catch (err) {
    console.error("sendShippingOTP error:", err);
    return res.status(500).json({ success: false, message: "Failed to send verification code." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/verify-shipping-otp — verify OTP for confirmation email
// Body: { email, otp }
// ─────────────────────────────────────────────────────────────────────────────
const verifyShippingOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const userId = req.user._id.toString();
    
    const schema = Joi.object({
      email: Joi.string().email().lowercase().required(),
      otp: Joi.string().length(6).pattern(/^\d+$/).required(),
    });
    
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    
    const storeKey = `${userId}-${email}`;
    const storedData = await findOTP(storeKey);
    
    if (!storedData) {
      return res.status(400).json({ success: false, message: "No verification code found. Please request a new one." });
    }
    
    if (isOTPExpired(storedData.expiry)) {
      await consumeOTP(storeKey);
      return res.status(400).json({ success: false, message: "Verification code expired. Please request a new one.", expired: true });
    }
    
    if (!safeEqual(hashOTP(otp), storedData.hashedOtp)) {
      return res.status(400).json({ success: false, message: "Invalid verification code." });
    }
    
    // OTP is valid — clear from store and save email to user's shipmentEmails
    await consumeOTP(storeKey);

    // Persist email to user profile so it appears in future checkout dropdowns
    try {
      const User = require("../models/User");
      await User.findByIdAndUpdate(req.user._id, {
        $addToSet: { shipmentEmails: email },
      });
    } catch (saveErr) {
      console.error("Failed to save shipment email to user profile:", saveErr);
      // Non-fatal — order can still proceed
    }

    return res.status(200).json({ 
      success: true, 
      message: "Email verified successfully!" 
    });
    
  } catch (err) {
    console.error("verifyShippingOTP error:", err);
    return res.status(500).json({ success: false, message: "Failed to verify code." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders  (authenticated user — place an order with shipping info)
// Body: { items, shippingDetails: { name, address, shpType, courierCompany, courierCity, phoneNumber, phoneNumber2, courierInstruction, shipping, allowToOpen } }
// ─────────────────────────────────────────────────────────────────────────────
const placeOrder = async (req, res) => {
  try {
    const { items, shippingDetails } = req.body;
    const voucherConversions = []; // { pvId, productId } — reserved uses claimed by this order
    let conversionCommitted = false; // true once reserved uses were converted to consumed

    if (!items || !items.length) {
      return res.status(400).json({ success: false, message: "Cart is empty." });
    }

    if (!shippingDetails) {
      return res.status(400).json({ success: false, message: "Shipping details are required." });
    }

    const required = ["name", "address", "shpType", "courierCompany", "courierCity", "phoneNumber", "shipping"];
    for (const field of required) {
      if (!shippingDetails[field] || !String(shippingDetails[field]).trim()) {
        return res.status(400).json({ success: false, message: `${field} is required.` });
      }
    }

    // Client idempotency key — a retry after a lost response must not create
    // a duplicate order. If an order for this key already exists, return it.
    const clientRequestId =
      typeof req.body.clientRequestId === "string" && req.body.clientRequestId.length <= 64
        ? req.body.clientRequestId
        : null;
    if (clientRequestId) {
      const existing = await Order.findOne({ clientRequestId, user: req.user._id }).lean();
      if (existing) {
        console.log(`[Order] Recovered existing order ${existing._id} for request ${clientRequestId}.`);
        return res.status(201).json({
          success: true,
          message: "Order placed successfully! Please check your email to confirm the order.",
          order: existing,
          confirmationNeeded: true,
        });
      }
    }

    // Validate products & build order items
    const orderItems = [];
    let totalAmount = 0;

    // Availability validation + order creation share one scope so ANY failure
    // (unknown product, Order/ShippingDetail/PreOrder write error) releases the
    // reserved voucher uses below.
    try {
      // Load the user's reserved voucher uses for the ordered products.
      // Validation: the voucher must belong to the user, have a reserved use
      // on that product, and not be expired — checked again here at order time.
      const itemIds = items.map((i) => i.productId).filter(Boolean);
      const voucherMap = new Map();
      if (itemIds.length > 0) {
        const reservedDocs = await PurchasedVoucher.find({
          user: req.user._id,
          "applied_products.status": "reserved",
          "applied_products.product": { $in: itemIds },
        }).lean();

        for (const pv of reservedDocs) {
          for (const entry of pv.applied_products || []) {
            if (entry.status !== "reserved") continue;
            const key = String(entry.product);
            if (itemIds.some((id) => String(id) === key) && !voucherMap.has(key)) {
              // Snapshot the whole voucher so pricing honours its discount
              // type (percent or flat rupees) and re-checks its conditions.
              voucherMap.set(key, {
                pvId: pv._id,
                discount_type: pv.discount_type || "percent",
                discount_percent: pv.discount_percent || 0,
                discount_amount: pv.discount_amount || 0,
                min_units: pv.min_units ?? 1,
                price_min: pv.price_min ?? null,
                price_max: pv.price_max ?? null,
                expires_at: pv.expires_at,
              });
            }
          }
        }
      }

      for (const item of items) {
        // Availability is a simple admin-controlled on/off toggle — nothing is
        // decremented and stock can never leak.
        const product = await Product.findById(item.productId);
        if (!product) {
          const err = new Error(`Product not found: ${item.productId}`);
          err.isStockError = true;
          throw err;
        }
        if (!productAvailability(product).inStock) {
          const err = new Error(`${product.name} is out of stock.`);
          err.isStockError = true;
          throw err;
        }

        // Popularity counter only — never used for availability.
        await Product.updateOne({ _id: product._id }, { $inc: { salesCount: item.quantity } });

        // User-level discount: only the admin-set custom percent applies.
        const userDiscPct = Math.min(
          100,
          Math.max(0, Number(req.user.customDiscountPercent) || 0),
        );

        // Voucher pricing — a reserved voucher on this product applies its
        // discount ON TOP of the user-level discount. Products without a
        // voucher still get the user-level discount.
        const voucherInfo = voucherMap.get(String(item.productId));
        if (voucherInfo && voucherInfo.expires_at && new Date(voucherInfo.expires_at) < new Date()) {
          const err = new Error(
            `The voucher applied to "${product.name}" has expired. Please remove it from the product and apply a valid voucher.`,
          );
          err.isStockError = true;
          throw err;
        }
        // User-level discount first, then the voucher on top of it.
        const basePrice = Math.round(product.salePrice * (1 - userDiscPct / 100));
        let unitPrice = basePrice;
        if (voucherInfo) {
          // Re-check the voucher's conditions against the live product — the
          // price may have changed since the voucher was applied to it, and the
          // cart line must now satisfy the voucher's unit rule (if it has one).
          const verdict = productSatisfiesVoucher(voucherInfo, product, item.quantity);
          if (!verdict.ok) {
            const err = new Error(verdict.reason);
            err.isStockError = true;
            // The unit rule is fixable: the customer just adds units and
            // retries in the same cart. Marking it keeps the voucher's
            // reservation alive (see the catch block below) so that retry
            // still gets the discount instead of silently charging full price.
            if (verdict.code === "unit_rule") err.isUnitRule = true;
            throw err;
          }
          unitPrice = applyVoucherDiscount(basePrice, voucherInfo);
        }

        orderItems.push({
          product: product._id,
          name: product.name,
          price: unitPrice,
          quantity: item.quantity,
          imageUrl: product.imageUrl || "",
          variation: typeof item.variation === "string" ? item.variation : "",
          // Public catalogue id (kp-00000000001) — ties the shipment line to
          // the exact product the customer bought.
          productId: product.productId || "",
        });

        totalAmount += unitPrice * item.quantity;
        if (voucherInfo) {
          voucherConversions.push({ pvId: voucherInfo.pvId, productId: item.productId });
        }

      }

      // Create the order
      const order = await Order.create({
        user: req.user._id,
        items: orderItems,
        totalAmount,
        clientRequestId,
      });

      // Order placed — convert the reserved voucher uses into permanently
      // consumed uses tied to this order.
      await convertReservationsToConsumed(order._id, voucherConversions);
      conversionCommitted = true;

      // Save the shipping details for this order
      const shippingDetail = await ShippingDetail.create({
        user: req.user._id,
        order: order._id,
        name: shippingDetails.name.trim(),
        address: shippingDetails.address.trim(),
        shpType: shippingDetails.shpType,
        courierCompany: shippingDetails.courierCompany.trim(),
        courierCity: shippingDetails.courierCity.trim(),
        phoneNumber: shippingDetails.phoneNumber.trim(),
        phoneNumber2: (shippingDetails.phoneNumber2 || "").trim(),
        sellPrice: totalAmount,
        businessProfiles: shippingDetails.businessProfiles || 1,
        courierInstruction: (shippingDetails.courierInstruction || "").trim(),
        email: (shippingDetails.orderConEmail || "").trim().toLowerCase(),
        shipping: shippingDetails.shipping,
        allowToOpen: shippingDetails.allowToOpen || "",
        latitude: shippingDetails.latitude ?? null,
        longitude: shippingDetails.longitude ?? null,
      });

      // Determine which email to use for order confirmation
      const orderConEmail = (shippingDetails.orderConEmail || req.user.email || "").trim().toLowerCase();

      // Create the pending PreOrder entry (awaiting customer confirmation)
      const confirmationToken = crypto.randomBytes(32).toString("hex");
      const confirmationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day

      const preOrder = await PreOrder.create({
        user: req.user._id,
        order: order._id,
        items: orderItems,
        totalAmount,
        name: shippingDetails.name.trim(),
        address: shippingDetails.address.trim(),
        shpType: shippingDetails.shpType,
        courierCompany: shippingDetails.courierCompany.trim(),
        courierCity: shippingDetails.courierCity.trim(),
        phoneNumber: shippingDetails.phoneNumber.trim(),
        phoneNumber2: (shippingDetails.phoneNumber2 || "").trim(),
        sellPrice: totalAmount,
        businessProfiles: shippingDetails.businessProfiles || 1,
        courierInstruction: (shippingDetails.courierInstruction || "").trim(),
        email: orderConEmail,
        shipping: shippingDetails.shipping,
        allowToOpen: shippingDetails.allowToOpen || "",
        latitude: shippingDetails.latitude ?? null,
        longitude: shippingDetails.longitude ?? null,
        status: "pending",
        confirmationExpiresAt,
        confirmationToken,
      });

      // Schedule auto-cancellation after 1 day
      schedulePreOrderCancellation(preOrder._id.toString());

      // Send confirmation link email to the order confirmation email. The
      // address is user-controlled and not OTP-gated at checkout — throttle
      // per address so an attacker cannot use this endpoint as a mail bomb.
      let emailSent = false;
      const cooldownSeconds = checkOrderConEmailCooldown(orderConEmail);
      if (cooldownSeconds > 0) {
        console.log(
          `[Order] Skipped confirmation email to ${orderConEmail} — cooldown ${cooldownSeconds}s.`,
        );
      } else {
        try {
          await sendOrderConfirmationLinkEmail(
            orderConEmail,
            shippingDetails.name.trim(),
            order,
            confirmationToken,
            getRequestBaseUrl(req),
          );
          emailSent = true;
          recordOrderConEmailSent(orderConEmail);
        } catch (emailErr) {
          console.error("Failed to send confirmation link email:", emailErr);
        }
      }

      return res.status(201).json({
        success: true,
        message: emailSent
          ? "Order placed successfully! Please check your email to confirm the order."
          : "Order placed, but we could not send the confirmation email. Please contact support.",
        order,
        confirmationNeeded: true,
        confirmationExpiresAt,
        emailSent,
      });
    } catch (err) {
      // Order was not successfully created — give the reserved voucher uses
      // back to the user automatically. If the conversion already committed,
      // the order exists and the uses stay consumed.
      // A unit-rule rejection is a "not yet" answer, not a dead order: the
      // voucher is still valid for this cart, the quantity is just short. Keep
      // the reservation so the customer's corrected retry is priced with the
      // discount; the 48h sweeper still reclaims it if they walk away.
      if (!conversionCommitted && !err.isUnitRule) {
        try {
          await releaseClaimedUses(voucherConversions);
          // Items never reached by the pricing loop (e.g. a stock error on an
          // earlier item) still hold reservations — free those too.
          const itemIds = (items || []).map((i) => i.productId).filter(Boolean);
          await releaseReservedForProducts(req.user._id, itemIds);
        } catch (voucherErr) {
          console.error("Failed to release voucher uses after failed order:", voucherErr);
        }
      }
      const status = err.isStockError ? 400 : 500;
      return res.status(status).json({ success: false, message: err.message || "Failed to place order." });
    }
  } catch (err) {
    console.error("placeOrder error:", err);
    return res.status(500).json({ success: false, message: "Failed to place order." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders/by-request/:clientRequestId  (authenticated user)
// Single source of truth for "was my order actually created?" — used by the
// frontend after a network error/timeout before deciding whether to release
// reserved voucher uses.
// ─────────────────────────────────────────────────────────────────────────────
const getOrderByClientRequestId = async (req, res) => {
  try {
    const { clientRequestId } = req.params;
    if (!clientRequestId) {
      return res.status(400).json({ success: false, message: "clientRequestId is required." });
    }
    const order = await Order.findOne({ clientRequestId, user: req.user._id })
      .select("_id totalAmount createdAt")
      .lean();
    res.json({ success: true, order: order || null });
  } catch (err) {
    console.error("Get order by request error:", err);
    res.status(500).json({ success: false, message: "Failed to check order status." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders/my  (authenticated user — their own orders)
// ─────────────────────────────────────────────────────────────────────────────
const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .populate("items.product", "name imageUrl salePrice lowPrice");

    const shippingDetails = await ShippingDetail.find({ user: req.user._id });
    const shippingMap = {};
    shippingDetails.forEach((s) => {
      shippingMap[s.order.toString()] = s;
    });

    return res.status(200).json({ success: true, orders, shippingMap });
  } catch (err) {
    console.error("getMyOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch orders." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders  (admin — all orders with full shipping details)
// ─────────────────────────────────────────────────────────────────────────────
const getAllOrders = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const [orders, total, allShipping] = await Promise.all([
      Order.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "name email")
        .populate("items.product", "name imageUrl salePrice lowPrice"),
      Order.countDocuments({}),
      ShippingDetail.find({}).lean(),
    ]);

    const shippingMap = {};
    allShipping.forEach((s) => {
      shippingMap[s.order.toString()] = s;
    });

    return res.status(200).json({
      success: true,
      orders,
      shippingMap,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getAllOrders error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch orders." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/orders/:id/status  (admin — update order status)
// ─────────────────────────────────────────────────────────────────────────────
const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ["pending", "confirmed", "shipped", "delivered", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }

    const order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const oldStatus = order.status;
    order.status = status;
    await order.save();

    // Admin cancelled the order — restore any consumed voucher uses
    if (status === "cancelled" && oldStatus !== "cancelled") {
      await restoreOrderVoucherUses(order._id);

      // A still-pending PreOrder for this order must be cancelled too —
      // otherwise the 24h auto-cancel timer would later fire on an order the
      // admin already cancelled, and the pending PreOrder queue would keep showing it.
      const pendingPre = await PreOrder.findOne({
        order: order._id,
        status: "pending",
      });
      if (pendingPre) {
        await PreOrder.updateOne(
          { _id: pendingPre._id },
          { $set: { status: "cancelled", confirmedAt: null, cancelReason: "Cancelled by admin." } },
        );
        cancelPreOrderCancellation(pendingPre._id.toString());
      }
    }

    // Log admin activity for status change
    await logActivity({
      user: req.user,
      action: ACTIONS.ORDER_STATUS_CHANGED,
      description: `Changed order #${order._id.toString().slice(-8).toUpperCase()} status from "${oldStatus}" to "${status}"`,
      req,
      metadata: { orderId: order._id, oldStatus, newStatus: status },
    });

    return res.status(200).json({ success: true, message: "Order status updated.", order });
  } catch (err) {
    console.error("updateOrderStatus error:", err);
    return res.status(500).json({ success: false, message: "Failed to update status." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/finalize/:id  (moves an admin-finalized order to the shipment queue)
// ─────────────────────────────────────────────────────────────────────────────
const finalizeOrder = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const order = await Order.findById(req.params.id).populate("items.product", "name sku");
    if (!order) {
      const [preOrder, mainOrderDoc] = await Promise.all([
        PreOrder.exists({ order: req.params.id, finalized: true }),
        ShipmentRecord.exists({ orderID: req.params.id }),
      ]);
      const alreadyFinalized = preOrder || mainOrderDoc;
      if (alreadyFinalized) {
        return res.status(200).json({ success: true, message: "Order already finalized." });
      }
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const sd = await ShippingDetail.findOne({ order: order._id });
    if (!sd) {
      return res.status(400).json({ success: false, message: "Shipping details not found for this order." });
    }

    const { preOrder, shipmentRecord: doc } = await createConfirmedOrderExports({
      user: order.user,
      order: order._id,
      items: order.items || [],
      totalAmount: order.totalAmount || 0,
      shipping: sd,
    });

    // The order is now in the shipment queue — remove the finalized PreOrder
    // record so it does not linger in the pending queue.
    await PreOrder.deleteOne({ _id: preOrder._id }).catch(() => {});

    // Remove the original pending records after both shared export records exist.
    await Order.deleteOne({ _id: order._id });
    await ShippingDetail.deleteOne({ _id: sd._id });

    return res.status(201).json({
      success: true,
      message: "Order finalized and stored in the shipment queue.",
      doc,
    });
  } catch (err) {
    console.error("finalizeOrder error:", err);
    return res.status(500).json({ success: false, message: "Failed to finalize order." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PreOrder confirmation processing
// ─────────────────────────────────────────────────────────────────────────────

function schedulePreOrderCancellation(preOrderId) {
  cancelPreOrderCancellation(preOrderId);
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const timeout = setTimeout(async () => {
    try {
      await processPreOrderCancellation(preOrderId);
    } catch (err) {
      console.error("processPreOrderCancellation error:", err);
    } finally {
      preOrderTimers.delete(preOrderId);
    }
  }, ONE_DAY);
  preOrderTimers.set(preOrderId, timeout);
}

function cancelPreOrderCancellation(preOrderId) {
  const timeout = preOrderTimers.get(preOrderId);
  if (timeout) {
    clearTimeout(timeout);
    preOrderTimers.delete(preOrderId);
  }
}

async function processPreOrderCancellation(preOrderId) {
  // Claim the pre-order atomically before doing any work: the confirm link
  // claims the same document via { status: { $ne: "confirmed" } } (success)
  // / { status: { $ne: "cancelled" } } (stock failure) — whichever claim wins,
  // the other request simply bails out, so a confirm that lands at the exact
  // same instant as the 24h timer can never double-process the order.
  const preOrder = await PreOrder.findOneAndUpdate(
    { _id: preOrderId, status: "pending" },
    { $set: { status: "cancelled", confirmedAt: null, cancelReason: "Order was automatically cancelled because the customer did not confirm the order within 24 hours." } },
  );
  if (!preOrder) return; // already confirmed / cancelled / processed

  try {
    // Not confirmed - move to CancelledOrders, restore stock
    // Restore stock for each item
    for (const item of preOrder.items) {
      await Product.findByIdAndUpdate(item.product, {
        $inc: { stock: item.quantity, salesCount: -item.quantity },
      }).catch(() => {});
    }

    await CancelledOrders.create({
      user: preOrder.user,
      order: preOrder.order,
      originalPreOrderId: preOrder._id,
      confirmationToken: preOrder.confirmationToken || "",
      items: preOrder.items,
      totalAmount: preOrder.totalAmount,
      name: preOrder.name,
      address: preOrder.address,
      shpType: preOrder.shpType,
      courierCompany: preOrder.courierCompany,
      courierCity: preOrder.courierCity,
      phoneNumber: preOrder.phoneNumber,
      phoneNumber2: preOrder.phoneNumber2,
      sellPrice: preOrder.sellPrice,
      businessProfiles: preOrder.businessProfiles,
      courierInstruction: preOrder.courierInstruction,
      email: preOrder.email,
      shipping: preOrder.shipping,
      allowToOpen: preOrder.allowToOpen,
      confirmed: false,
      cancelledAt: new Date(),
      cancelReason: "Order was automatically cancelled because the customer did not confirm the order within 24 hours.",
    });

    // Restore any voucher uses consumed by this order
    await restoreOrderVoucherUses(preOrder.order);

    // Remove the original Order + ShippingDetail from daily collections
    await Order.deleteOne({ _id: preOrder.order });
    await ShippingDetail.deleteOne({ order: preOrder.order });

    await PreOrder.deleteOne({ _id: preOrder._id });
    console.log(`[PreOrder] Order ${preOrder.order} not confirmed — moved to CancelledOrders, stock restored.`);
  } catch (err) {
    console.error(`[PreOrder] Error processing ${preOrderId}:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders/confirm/:token  — confirm an order via emailed link
// Moves an order from the PreOrder queue into the shipment queue.
//
// Stock gate: the order only moves to main orders when every item's required
// quantity is actually available on the website. Otherwise it becomes a
// late-confirmation order (stock restored, customer + admin notified) and is
// managed manually. Both this route AND /api/workflow/confirm-preorder/:token
// resolve to this one canonical handler.
// ─────────────────────────────────────────────────────────────────────────────
const confirmOrder = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 10) {
      return res.status(400).json({ success: false, message: "Invalid confirmation token." });
    }

    const preOrder = await PreOrder.findOne({ confirmationToken: token });
    if (!preOrder) {
      // The confirmation link may have been used already. The successful
      // confirmation flow deletes the PreOrder, so a repeated click can no
      // longer find it here — check the shipment records instead and
      // report a friendly "already confirmed" instead of a scary "invalid link".
      const alreadyMoved = await ShipmentRecord.findOne({ confirmationToken: token });
      if (alreadyMoved) {
        return res.status(200).json({ success: true, message: "Order already confirmed." });
      }
      // The order may have been auto-cancelled (24h window passed) or
      // cancelled by the customer — tell the user what happened instead of
      // a generic "invalid link".
      const cancelled = await CancelledOrders.findOne({ confirmationToken: token });
      if (cancelled) {
        return res.status(400).json({
          success: false,
          message: "This order was not confirmed in time and has been cancelled.",
          expired: true,
        });
      }
      return res.status(404).json({ success: false, message: "Confirmation link is invalid or expired." });
    }

    if (preOrder.status === "confirmed") {
      return res.status(200).json({ success: true, message: "Order already confirmed." });
    }

    if (new Date() > new Date(preOrder.confirmationExpiresAt)) {
      return res.status(400).json({ success: false, message: "Confirmation period has expired. The order has been cancelled.", expired: true });
    }

    // ── Stock gate: every item must be available on the website ─────────────
    const stockChecks = [];
    for (const item of preOrder.items) {
      const productId = item.product?._id || item.product;
      if (!productId) {
        stockChecks.push({ ok: false, name: item.name || "Unknown", reason: "No product reference" });
        continue;
      }
      const product = await Product.findById(productId).lean();
      if (!product) {
        stockChecks.push({ ok: false, name: item.name || "Unknown", reason: "Product not found" });
        continue;
      }
      if (!productAvailability(product).inStock) {
        stockChecks.push({ ok: false, name: product.name, reason: "Out of stock" });
      } else {
        stockChecks.push({ ok: true });
      }
    }

    const allStockOk = stockChecks.every((c) => c.ok);

    if (!allStockOk) {
      const failedItems = stockChecks.filter((c) => !c.ok);

      // Claim the pre-order atomically so the 24h timer / double click can't
      // double-process the same failed confirmation.
      const claimed = await PreOrder.findOneAndUpdate(
        { _id: preOrder._id, status: { $ne: "cancelled" } },
        { $set: { status: "cancelled", confirmedAt: null, cancelReason: "Late confirmation — product not available on website" } },
      );
      if (!claimed) {
        return res.status(200).json({ success: false, message: "This order was already processed." });
      }
      cancelPreOrderCancellation(preOrder._id.toString());

      // Archive to late-confirmation orders for manual handling
      await LateConfirmationOrder.create({
        user: preOrder.user,
        order: preOrder.order,
        originalPreOrderId: preOrder._id,
        items: normalizeLateOrderItems(preOrder.items),
        totalAmount: preOrder.totalAmount,
        name: preOrder.name,
        address: preOrder.address,
        shpType: preOrder.shpType,
        courierCompany: preOrder.courierCompany,
        courierCity: preOrder.courierCity,
        phoneNumber: preOrder.phoneNumber,
        phoneNumber2: preOrder.phoneNumber2,
        sellPrice: preOrder.sellPrice,
        businessProfiles: preOrder.businessProfiles,
        courierInstruction: preOrder.courierInstruction,
        email: preOrder.email,
        shipping: preOrder.shipping,
        allowToOpen: preOrder.allowToOpen,
        notifiedAt: new Date(),
      });

      // Restore stock
      for (const item of preOrder.items) {
        await Product.findByIdAndUpdate(item.product?._id || item.product, {
          $inc: { stock: item.quantity, salesCount: -item.quantity },
        }).catch(() => {});
      }

      // Notify the customer
      try {
        await sendLateConfirmationEmail(preOrder.email, preOrder.name, preOrder);
      } catch (emailErr) {
        console.error("[Confirm] Failed to send late confirmation email:", emailErr);
      }

      // Notify the admin — the email names the user: late confirmation,
      // product not available, everything will be handled manually.
      try {
        await sendAdminStockAlertEmail({
          orderId: preOrder.order,
          customerName: preOrder.name,
          customerEmail: preOrder.email,
          orderType: "late confirmation (pre-order)",
        });
      } catch (emailErr) {
        console.error("[Confirm] Failed to send admin stock alert email:", emailErr);
      }

      // Order never fulfilled — restore any voucher uses consumed by it
      await restoreOrderVoucherUses(preOrder.order);

      // Cleanup daily collections
      await Order.deleteOne({ _id: preOrder.order }).catch(() => {});
      await ShippingDetail.deleteOne({ order: preOrder.order }).catch(() => {});
      await PreOrder.deleteOne({ _id: preOrder._id }).catch(() => {});

      console.log(`[PreOrder] Order ${preOrder.order} — late confirmation, product not available. Moved to late_confirmation_orders for manual handling.`);

      return res.status(200).json({
        success: false,
        message: "Stock is currently unavailable. A notification has been sent to your email.",
        stockIssues: failedItems,
        lateConfirmation: true,
      });
    }

    // ── Stock OK — move into the shipment queue ───────────────
    // Claim the pre-order atomically: only one request may confirm it; the
    // 24h auto-cancel timer also claims via the same status transition.
    const claimed = await PreOrder.findOneAndUpdate(
      { _id: preOrder._id, status: { $ne: "confirmed" } },
      { $set: { status: "confirmed", confirmedAt: new Date() } },
    );
    if (!claimed) {
      return res.status(200).json({ success: true, message: "Order already confirmed." });
    }

    // Cancel the scheduled timer
    cancelPreOrderCancellation(preOrder._id.toString());

    try {
      // Move into the shipment queue
      const populatedPreOrder = await PreOrder.findOne({ _id: preOrder._id })
        .populate("items.product", "sku name")
        .lean();

      const items = populatedPreOrder?.items || preOrder.items || [];
      const { preOrder: finalizedPreOrder } = await createConfirmedOrderExports({
        user: preOrder.user,
        order: preOrder.order,
        items: preOrder.items || [],
        shipmentItems: items,
        totalAmount: preOrder.totalAmount || 0,
        shipping: preOrder,
      });

      // The order is now in the shipment queue — remove it from Pre Orders so it
      // does not linger in the pending queue. Prefer the record that
      // was actually finalized (keeps the token for duplicate-link handling).
      const pid = finalizedPreOrder && finalizedPreOrder._id
        ? finalizedPreOrder._id
        : preOrder._id;
      await PreOrder.deleteOne({ _id: pid });

      // Keep the token on the moved record so a repeated click on the emailed
      // link resolves to "already confirmed" instead of "invalid link".
      await ShipmentRecord.updateOne(
        { orderID: preOrder.order.toString() },
        { $set: { confirmationToken: token } },
      );

      // Remove the original Order + ShippingDetail from daily collections
      await Order.deleteOne({ _id: preOrder.order });
      await ShippingDetail.deleteOne({ order: preOrder.order });
    } catch (err) {
      // Moving into the shipment queue failed — revert the order to "pending" so it
      // is never left half-confirmed / stuck outside both queues. The scheduled
      // auto-cancellation timer resumes and the admin can retry later.
      console.error(`[PreOrder] Confirm move failed for ${preOrder._id}:`, err);
      await PreOrder.updateOne(
        { _id: preOrder._id },
        { $set: { status: "pending", confirmedAt: null } },
      ).catch(() => {});
      schedulePreOrderCancellation(preOrder._id.toString());
      throw err;
    }

    console.log(`[PreOrder] Order ${preOrder.order} confirmed — moved to ShipmentRecord.`);

    // Send order receipt email
    try {
      const receiptOrder = await Order.findById(preOrder.order).lean();
      if (receiptOrder) {
        await sendOrderConfirmationEmail(
          preOrder.email || "",
          preOrder.name || "Customer",
          receiptOrder,
          { name: preOrder.name, phoneNumber: preOrder.phoneNumber, phoneNumber2: preOrder.phoneNumber2, address: preOrder.address, courierCity: preOrder.courierCity, shpType: preOrder.shpType, courierCompany: preOrder.courierCompany, shipping: preOrder.shipping },
        );
      }
    } catch (receiptErr) {
      console.error("Failed to send confirmation receipt email:", receiptErr);
    }

    return res.status(200).json({
      success: true,
      message: "Order confirmed successfully! Thank you.",
      orderId: preOrder.order.toString(),
    });
  } catch (err) {
    console.error("confirmOrder error:", err);
    return res.status(500).json({ success: false, message: "Failed to confirm order." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Loyalty points — awarded when an order is CONFIRMED (never at checkout, and
// never again on re-confirmation).
//
// The shipment record itself carries the award (`pointsAwarded`), so the
// conditional update below is what makes this idempotent: two concurrent
// confirms can both compute the same number, but only one wins the update and
// only that one credits the customer.
// 5 points per full Rs 300 of the confirmed order value.
// ─────────────────────────────────────────────────────────────────────────────
function pointsForOrder(totalAmount) {
  const total = Number(totalAmount) || 0;
  if (total <= 0) return 0;
  return Math.floor(total / 300) * 5;
}

const awardOrderPoints = async (record, fallbackUserId = null) => {
  if (!record || Number(record.pointsAwarded) > 0) return 0;

  const points = pointsForOrder(record.sellPrice);
  if (points <= 0) return 0;

  const claimed = await ShipmentRecord.findOneAndUpdate(
    { _id: record._id, pointsAwarded: { $not: { $gt: 0 } } },
    { $set: { pointsAwarded: points, confirmedAt: record.confirmedAt || new Date() } },
    { new: true },
  );
  // Lost the race — someone else already awarded this order's points.
  if (!claimed) return 0;

  const userId = record.user || fallbackUserId;
  if (userId) {
    try {
      const User = require("../models/User");
      const user = await User.findByIdAndUpdate(
        userId,
        { $inc: { loyaltyPoints: points } },
        { new: true },
      );
      const io = global.__kifayatIo;
      if (io && user) {
        io.to(`user-${userId}`).emit("loyalty_points_awarded", {
          points,
          total: user.loyaltyPoints,
          orderID: record.orderID,
        });
      }
    } catch (err) {
      console.error("Failed to credit loyalty points:", err);
    }
  }

  try {
    await logActivity({
      action: ACTIONS.ORDER_STATUS_CHANGED,
      description: `Order ${record.orderID} confirmed — ${points} loyalty points awarded`,
      metadata: { orderID: String(record.orderID), points, user: String(userId || "") },
    });
  } catch {}

  return points;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/orders/:orderId/confirm  (admin only)
//
// The WhatsApp flow: the admin calls/messages the customer, then confirms the
// order straight from the panel. Runs the exact same handler as the emailed
// confirmation link (same stock gate, same customer emails, same queue move)
// and then credits the order's loyalty points once.
//
// `orderId` may be a PreOrder _id or the Order _id it belongs to. Confirming
// an order that is already in the shipment queue is safe — it only makes sure
// the points were credited.
// ─────────────────────────────────────────────────────────────────────────────
const adminConfirmOrder = async (req, res) => {
  try {
    const orderId = String(req.params.orderId || "").trim();
    if (!orderId) {
      return res.status(400).json({ success: false, message: "Order id is required." });
    }

    let preOrder = null;
    if (mongoose.isValidObjectId(orderId)) {
      preOrder = await PreOrder.findById(orderId).catch(() => null);
    }
    if (!preOrder) {
      preOrder = await PreOrder.findOne({ order: orderId });
    }

    if (!preOrder) {
      // Not pending — either already confirmed or never existed. If a shipment
      // record exists, make sure its points were credited and report success.
      const record = await ShipmentRecord.findOne({ orderID: orderId });
      if (record) {
        const credited = await awardOrderPoints(record);
        return res.status(200).json({
          success: true,
          alreadyConfirmed: true,
          pointsAwarded: credited,
          message: credited
            ? `Order already confirmed — ${credited} loyalty points credited.`
            : "Order already confirmed.",
        });
      }
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const token = preOrder.confirmationToken;
    if (!token || token.length < 10) {
      return res.status(400).json({
        success: false,
        message: "This order has no confirmation token — it cannot be confirmed from the panel.",
      });
    }

    // Reuse the canonical link-confirmation handler through a capturing response.
    const captured = { status: 500, payload: null };
    const captureRes = {
      status(code) { captured.status = code; return this; },
      json(payload) { captured.payload = payload; return this; },
    };
    await confirmOrder({ params: { token }, app: req.app }, captureRes);

    const payload = captured.payload || {};
    const confirmed = captured.status === 200 && payload.success !== false;

    let pointsAwarded = 0;
    if (confirmed) {
      const orderKey = preOrder.order?.toString?.() || orderId;
      const record = await ShipmentRecord.findOne({ orderID: orderKey });
      pointsAwarded = await awardOrderPoints(record, preOrder.user);
    }

    return res.status(captured.status || 200).json({
      ...payload,
      pointsAwarded,
      loyaltyPoints: pointsAwarded > 0 ? pointsAwarded : undefined,
    });
  } catch (err) {
    console.error("adminConfirmOrder error:", err);
    return res.status(500).json({ success: false, message: "Failed to confirm order." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/cancel/:token  — cancel an order via emailed link
// Moves order from PreOrder to CancelledOrders
// ─────────────────────────────────────────────────────────────────────────────
const cancelOrder = async (req, res) => {
  try {
    const { token } = req.params;
    if (!token || token.length < 10) {
      return res.status(400).json({ success: false, message: "Invalid cancellation token." });
    }

    const preOrder = await PreOrder.findOne({ confirmationToken: token });
    if (!preOrder) {
      return res.status(404).json({ success: false, message: "Cancellation link is invalid or expired." });
    }

    if (preOrder.status === "confirmed") {
      return res.status(400).json({ success: false, message: "Order already confirmed and cannot be cancelled." });
    }

    // Cancel the scheduled timer
    cancelPreOrderCancellation(preOrder._id.toString());

    // Restore stock for each item
    for (const item of preOrder.items) {
      await Product.findByIdAndUpdate(item.product, {
        $inc: { stock: item.quantity, salesCount: -item.quantity },
      }).catch(() => {});
    }

    // Move to CancelledOrders
    await CancelledOrders.create({
      user: preOrder.user,
      order: preOrder.order,
      originalPreOrderId: preOrder._id,
      confirmationToken: preOrder.confirmationToken || "",
      items: preOrder.items,
      totalAmount: preOrder.totalAmount,
      name: preOrder.name,
      address: preOrder.address,
      shpType: preOrder.shpType,
      courierCompany: preOrder.courierCompany,
      courierCity: preOrder.courierCity,
      phoneNumber: preOrder.phoneNumber,
      phoneNumber2: preOrder.phoneNumber2,
      sellPrice: preOrder.sellPrice,
      businessProfiles: preOrder.businessProfiles,
      courierInstruction: preOrder.courierInstruction,
      email: preOrder.email,
      shipping: preOrder.shipping,
      allowToOpen: preOrder.allowToOpen,
      confirmed: false,
      cancelledAt: new Date(),
      cancelReason: "Order cancelled by user.",
    });

    // Restore any voucher uses consumed by this order
    await restoreOrderVoucherUses(preOrder.order);

    // Remove the original Order + ShippingDetail from daily collections
    await Order.deleteOne({ _id: preOrder.order });
    await ShippingDetail.deleteOne({ order: preOrder.order });

    // Remove from PreOrder
    await PreOrder.deleteOne({ _id: preOrder._id });

    console.log(`[PreOrder] Order ${preOrder.order} cancelled — moved to CancelledOrders, stock restored.`);

    return res.status(200).json({
      success: true,
      message: "Order cancelled successfully. Stock has been restored.",
    });
  } catch (err) {
    console.error("cancelOrder error:", err);
    return res.status(500).json({ success: false, message: "Failed to cancel order." });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Restore pending PreOrder timers on server restart
// ─────────────────────────────────────────────────────────────────────────────
async function restorePendingPreOrders() {
  try {
    const now = new Date();
    const expired = await PreOrder.find({ status: "pending", confirmationExpiresAt: { $lte: now } });
    for (const preOrder of expired) {
      await processPreOrderCancellation(preOrder._id.toString());
    }

    const pending = await PreOrder.find({ status: "pending", confirmationExpiresAt: { $gt: now } });
    for (const preOrder of pending) {
      schedulePreOrderCancellation(preOrder._id.toString());
    }

    // Self-healing: any PreOrder that is confirmed/finalized but still sitting
    // in Pre Orders (e.g. a crashed move, or an old flow that kept the record)
    // belongs in the shipment queue. Move it there now so the pending queue never
    // holds orders that are already confirmed.
    const stuck = await PreOrder.find({
      status: "confirmed",
    });
    let moved = 0;
    for (const preOrder of stuck) {
      try {
        const orderId = preOrder.order?.toString?.() || "";
        if (!orderId) continue;

        const alreadyMoved = await ShipmentRecord.exists({ orderID: orderId });
        if (alreadyMoved) {
          // The confirm flow deletes the daily Order + ShippingDetail when it
          // moves an order into the shipment queue — a leftover here means a crashed move.
          // Clean the ghosts so daily collections never hold dead records.
          await PreOrder.deleteOne({ _id: preOrder._id }).catch(() => {});
          await Order.deleteOne({ _id: orderId }).catch(() => {});
          await ShippingDetail.deleteOne({ order: orderId }).catch(() => {});
          moved += 1;
          continue;
        }

        const populated = await PreOrder.findById(preOrder._id)
          .populate("items.product", "sku name")
          .lean();
        await createConfirmedOrderExports({
          user: preOrder.user,
          order: preOrder.order,
          items: preOrder.items || [],
          shipmentItems: populated?.items || [],
          totalAmount: preOrder.totalAmount || 0,
          shipping: preOrder,
        });
        await PreOrder.deleteOne({ _id: preOrder._id }).catch(() => {});
        // The move is complete — the daily records are now redundant
        // (mirrors what the confirm/finalize flow does after the queue move).
        await Order.deleteOne({ _id: orderId }).catch(() => {});
        await ShippingDetail.deleteOne({ order: orderId }).catch(() => {});
        moved += 1;
        console.log(`[PreOrder] Swept stuck confirmed pre-order ${preOrder._id} into the shipment queue.`);
      } catch (sweepErr) {
        console.error(`[PreOrder] Sweep failed for ${preOrder._id}:`, sweepErr.message);
      }
    }

    const total = expired.length + pending.length;
    if (total > 0) {
      console.log(`[PreOrder] Restored ${total} pending pre-orders (${expired.length} expired, ${pending.length} pending)`);
    }
    if (moved > 0) {
      console.log(`[PreOrder] Moved ${moved} confirmed pre-order(s) into the shipment queue.`);
    }
  } catch (err) {
    console.error("[PreOrder] Restore error:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/orders/count  (public — storefront trust proof)
// ─────────────────────────────────────────────────────────────────────────────
const getPublicOrderCount = async (req, res) => {
  try {
    const [orders, purchased] = await Promise.all([
      Order.countDocuments(),
      require("../models/ShipmentRecord").countDocuments({}).catch(() => 0),
    ]);
    return res.status(200).json({ success: true, total: orders + (purchased || 0) });
  } catch (err) {
    return res.status(200).json({ success: true, total: 0 });
  }
};

module.exports = {
  placeOrder,
  getMyOrders,
  getAllOrders,
  updateOrderStatus,
  sendShippingOTP,
  verifyShippingOTP,
  finalizeOrder,
  confirmOrder,
  adminConfirmOrder,
  awardOrderPoints,
  pointsForOrder,
  cancelOrder,
  getOrderByClientRequestId,
  processPreOrderCancellation,
  restorePendingPreOrders,
  getPublicOrderCount,
};
