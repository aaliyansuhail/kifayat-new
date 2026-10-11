const mongoose = require("mongoose");

const productInteractionSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      index: true,
    },
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    interactionType: {
      type: String,
      enum: ["click", "hover", "view", "pageview"],
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    sessionId: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
    referrer: {
      type: String,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    collection: "product_interactions",
  }
);

// Compound indexes for efficient queries
productInteractionSchema.index({ productId: 1, interactionType: 1, createdAt: -1 });
productInteractionSchema.index({ sellerId: 1, interactionType: 1, createdAt: -1 });
productInteractionSchema.index({ createdAt: -1 });

module.exports = mongoose.model("ProductInteraction", productInteractionSchema);
