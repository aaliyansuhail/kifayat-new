const mongoose = require("mongoose");

const purchasedVoucherSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    voucher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DiscountVoucher",
      required: true,
    },
    source: {
      type: String,
      enum: ["purchased", "gifted"],
      default: "purchased",
    },
    gifted_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    gifted_at: {
      type: Date,
      default: null,
    },
    voucher_code: {
      type: String,
      default: "",
    },
    voucher_type: {
      type: String,
      enum: ["discount_all", "discount_specific", "free_product"],
      default: "discount_all",
    },
    products: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Product",
      },
    ],
    // The voucher's conditions are SNAPSHOT onto the purchased copy, so an
    // admin later editing or deleting the published voucher can never change
    // what a customer already owns or what the order pricing applies.
    discount_type: {
      type: String,
      enum: ["percent", "amount"],
      default: "percent",
    },
    discount_percent: {
      type: Number,
      default: 0,
    },
    // Flat rupee discount (used when discount_type === "amount").
    discount_amount: {
      type: Number,
      default: 0,
    },
    // How many products this voucher may be applied to (mirrors total_uses).
    product_quantity: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Minimum units of one product required in the cart (snapshotted from the
    // published voucher). 1 = no unit rule.
    min_units: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Applicable product price range. null = unbounded on that side.
    price_min: {
      type: Number,
      default: null,
    },
    price_max: {
      type: Number,
      default: null,
    },
    points_spent: {
      type: Number,
      required: true,
    },
    used: {
      type: Boolean,
      default: false,
    },
    used_at: {
      type: Date,
      default: null,
    },
    total_uses: {
      type: Number,
      default: 1,
      min: 1,
    },
    expires_at: {
      type: Date,
      default: null,
    },
    applied_products: [
      {
        _id: false,
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
        },
        slug: {
          type: String,
          default: "",
        },
        applied_at: {
          type: Date,
          default: Date.now,
        },
        status: {
          type: String,
          enum: ["reserved", "consumed"],
          default: "reserved",
        },
        order: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Order",
          default: null,
        },
      },
    ],
  },
  { timestamps: { createdAt: "purchased_at", updatedAt: false }, collection: "purchased_vouchers" }
);

purchasedVoucherSchema.index({ user: 1, purchased_at: -1 });
purchasedVoucherSchema.index({ voucher: 1 });

// Enforce "one voucher use per product per user" at the database level —
// two vouchers can never be applied to the same product (concurrent
// applyVoucher requests used to slip past the application-level check).
//
// The index MUST be partial: a freshly bought voucher has no applied products
// yet, and a plain multikey unique index would key every such document as
// { user, applied_products.product: null } — so buying a second voucher before
// applying the first failed with E11000. The partial filter keeps documents
// with no applied products out of the index entirely.
purchasedVoucherSchema.index(
  { user: 1, "applied_products.product": 1 },
  {
    unique: true,
    name: "user_1_applied_products.product_1",
    partialFilterExpression: { "applied_products.product": { $exists: true } },
  },
);

module.exports = mongoose.model("PurchasedVoucher", purchasedVoucherSchema);
