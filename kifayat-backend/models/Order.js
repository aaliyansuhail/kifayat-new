const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 },
  imageUrl: { type: String, default: "" },
  // Selected product variation (label) chosen at checkout.
  variation: { type: String, default: "" },
  // Public product id (kp-00000000001) captured at checkout so the shipment
  // record can always be traced back to the exact catalogue item.
  productId: { type: String, default: "" },
});

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    items: [orderItemSchema],
    totalAmount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["pending", "confirmed", "shipped", "delivered", "cancelled"],
      default: "pending",
    },
    // Client-generated idempotency key: lets the frontend recover an order
    // whose success response was lost to a network error or timeout.
    clientRequestId: { type: String, default: null },
  },
  { timestamps: true, collection: "orders" },
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ user: 1, clientRequestId: 1 });

module.exports = mongoose.model("Order", orderSchema);
