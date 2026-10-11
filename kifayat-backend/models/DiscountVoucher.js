const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// DiscountVoucher — a voucher the admin PUBLISHES for customers to buy with
// their loyalty points.
//
// Every field below is a condition the customer's product must satisfy before
// the voucher can be applied to it (see utils/voucherRules.js):
//   • discount_type/discount_percent/discount_amount — what the discount is
//     (a percentage OR a flat rupee amount)
//   • product_quantity — how many DIFFERENT products the voucher may be
//     applied to (one use per product)
//   • min_units — how many UNITS of a single product the customer must put in
//     the cart for the voucher to apply. 1 (the default) means "no unit rule",
//     which is exactly how every voucher behaved before this field existed.
//   • price_min/price_max — the product price range the voucher is valid on
//     (matched against the product's sale price, ignoring quantity)
//   • points_required, expires_at — what it costs and how long it lasts
// ─────────────────────────────────────────────────────────────────────────────

const discountVoucherSchema = new mongoose.Schema(
  {
    voucher_code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    // "percent" → discount_percent applies, "amount" → discount_amount applies.
    discount_type: {
      type: String,
      enum: ["percent", "amount"],
      default: "percent",
    },
    discount_percent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Flat discount in rupees (used when discount_type === "amount").
    discount_amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // How many products this voucher may be applied to.
    product_quantity: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Minimum units of ONE product required in the cart for the voucher to
    // apply. 1 = no unit rule (backwards compatible default).
    min_units: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Applicable product price range. null = unbounded on that side.
    price_min: {
      type: Number,
      default: null,
      min: 0,
    },
    price_max: {
      type: Number,
      default: null,
      min: 0,
    },
    points_required: {
      type: Number,
      required: true,
      min: 0,
    },
    purchased_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    purchased_at: {
      type: Date,
      default: null,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    expires_at: {
      type: Date,
      default: null,
    },
    is_active: {
      type: Boolean,
      default: true,
    },
    // Legacy field kept in sync with product_quantity for older records.
    max_uses: {
      type: Number,
      default: null,
    },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false }, collection: "discount_vouchers" }
);

discountVoucherSchema.index({ is_active: 1, created_at: -1 });

module.exports = mongoose.model("DiscountVoucher", discountVoucherSchema);
