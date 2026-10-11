const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Product — catalogue item created by an admin (or a seller).
//
// Suppliers and CSV imports are gone: every product is created through the
// admin "Add Product" form (or the seller product form) with an explicit
// sale price shown to customers and a private cost price used internally.
//
// Product ids are sequential and human readable: kp-00000000001,
// kp-00000000002, … The storefront resolves /products/kp-00000000001.
// ─────────────────────────────────────────────────────────────────────────────

const productSchema = new mongoose.Schema(
  {
    // Public identifier, e.g. "kp-00000000001"
    productId: { type: String, default: "", trim: true },
    // Optional merchant SKU (seller listings / internal bookkeeping)
    sku: { type: String, default: "", trim: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    // What the store pays to buy the product — NEVER exposed to customers.
    costPrice: { type: Number, default: 0, min: 0 },
    // What the customer pays. Every discount, voucher and total is computed
    // from this value.
    salePrice: { type: Number, default: 0, min: 0 },
    sellerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Availability is an admin-controlled on/off switch: customers only ever
    // see "In stock" or "Out of stock" (never a number). Orders do not
    // decrement anything and nothing is auto-deleted.
    inStock: { type: Boolean, default: true },
    // Legacy numeric fields — retained only so older records keep loading.
    // They are no longer written or read as the source of truth.
    stock: { type: Number, default: 0, min: 0 },
    originalStock: { type: Number, default: 0, min: 0 },
    category: { type: String, default: "Uncategorized", trim: true },
    // Customer-facing department, used by the Fashion category's Men/Women
    // filter. "unisex" items surface under both filters.
    gender: {
      type: String,
      enum: ["men", "women", "unisex"],
      default: "unisex",
      trim: true,
    },
    // SEO — filled by the admin edit form and the AI "SEO Booster"; routed to
    // site search and the product page's meta/JSON-LD.
    keywords: { type: [String], default: [] },
    seoTitle: { type: String, default: "", trim: true },
    seoDescription: { type: String, default: "", trim: true },
    // Ordered gallery uploaded by the admin (minimum 3 images).
    images: { type: [String], default: [] },
    // Primary video (minimum 1). `video` is the canonical field, `videoUrl`
    // mirrors it for older storefront code paths.
    video: { type: String, default: "", trim: true },
    // Primary image = first gallery image; kept for cards, sitemaps and search.
    imageUrl: { type: String, default: "", trim: true },
    videoUrl: { type: String, default: "", trim: true },
    // Ordered media: [{ id, url, type: image|video }] — drives the product page
    // gallery/lightbox.
    gallery: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Seller price/stock options: [{ id, name, price, salePrice, quantity }]
    variations: { type: mongoose.Schema.Types.Mixed, default: [] },
    hidden: { type: Boolean, default: false },
    weight: { type: Number, default: 0, min: 0 },
    salesCount: { type: Number, default: 0, min: 0 },
    stockOutAt: { type: Date, default: null },
    pendingDeleteAt: { type: Date, default: null },
    featuredOnLanding: { type: Boolean, default: false },
    featuredOrder: { type: Number, default: null },
    manualPosition: { type: Number, default: null },
    // Soft-delete: when true the product is hidden from storefront + admin list
    // but preserved in the database for the "Deleted Products" admin page.
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "products" },
);

productSchema.index({ category: 1 });
productSchema.index({ category: 1, gender: 1 });
productSchema.index({ sku: 1 });
productSchema.index({ productId: 1 });
productSchema.index({ stockOutAt: 1 });
productSchema.index({ pendingDeleteAt: 1 });
productSchema.index({ costPrice: 1 });
productSchema.index({ sellerId: 1 });
productSchema.index({ name: "text", description: "text", sku: "text", productId: "text", keywords: "text" });
// Query/scan indexes for the public catalogue — cover the filters and sorts
// used by getProducts / getFeaturedLanding so scans & in-memory sorts are avoided.
productSchema.index({ hidden: 1, createdAt: -1 });
productSchema.index({ hidden: 1, salesCount: -1 });
productSchema.index({ hidden: 1, category: 1 });
productSchema.index({ salePrice: 1 });
productSchema.index({ featuredOnLanding: 1, updatedAt: -1 });
productSchema.index({ manualPosition: 1 });
productSchema.index({ slug: 1 });
productSchema.index({ deleted: 1, deletedAt: -1 });

// Remove the private cost price before sending anything to customers.
productSchema.methods.toPublicObject = function () {
  const obj = this.toObject();
  delete obj.costPrice;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Product", productSchema);
