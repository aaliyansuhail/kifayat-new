const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "kifayat-backend", "controllers", "orderController.js");
let s = fs.readFileSync(file, "utf8");

const isBanner = (l) => /^\/\/\s*─+\s*$/.test(l.trimEnd());
function startOfBannerBefore(markerIdx) {
  const lines = s.slice(0, markerIdx).split("\n");
  let i = lines.length - 1;
  if (lines[i].trim() === "") i -= 1;
  while (i >= 0 && isBanner(lines[i])) i -= 1;
  let first = i + 1;
  while (first - 1 >= 0 && isBanner(lines[first - 1])) first -= 1;
  return lines.slice(0, first).join("\n").length + (first > 0 ? 1 : 0);
}
const cut = (startMarker, endMarker, repl) => {
  const a = s.indexOf(startMarker);
  if (a < 0) throw new Error("start not found: " + startMarker.slice(0, 50));
  const b = s.indexOf(endMarker, a + 1);
  if (b < 0) throw new Error("end not found: " + endMarker.slice(0, 50));
  const start = startOfBannerBefore(a);
  s = s.slice(0, start) + repl + s.slice(b);
};

const BANNER = "// ─────────────────────────────────────────────────────────────────────────────\n";

const helper = `${BANNER}// Build the numbered product/variation/qty fields for a shipment record.
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

    productFields[\`product\${i}\`] = publicId;
    productFields[\`variation\${i}\`] = variation;
    productFields[\`qty\${i}\`] = quantity;

    productExtras[\`productSku\${i}\`] = sku;
    productExtras[\`variationName\${i}\`] = variation;
    productExtras[\`productName\${i}\`] = name;
    productExtras[\`productPrice\${i}\`] = unitPrice;

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

`;

cut("async function createConfirmedOrderExports({", "// Shipping email OTPs are stored in MongoDB", helper);

// Remove the deleted HHC helper import.
s = s.replace('const { buildHhcCSVProductFields, matchVariation } = require("../utils/hhcExport");\n', "");

// placeOrder — drop variation-id resolution and HHC comments.
s = s.replace(`        const variant = matchVariation(
          product,
          typeof item.variation === "string" ? item.variation : "",
        );

`, "");
s = s.replace(`          variation: typeof item.variation === "string" ? item.variation : "",
          // Resolve the exact HHC ids at checkout so the PreOrder and the Main
          // Order CSV data carry the variation id / product id immediately.
          variationId:
            variant && variant.id !== undefined && variant.id !== null
              ? String(variant.id)
              : "",
          productId: product.productId || "",`,
`          variation: typeof item.variation === "string" ? item.variation : "",
          // Public catalogue id (kp-00000000001) — ties the shipment line to
          // the exact product the customer bought.
          productId: product.productId || "",`);
s = s.replace("      // Save shipping details matching HHC CSV format", "      // Save the shipping details for this order");
s = s.replace("      // Create PreOrder entry immediately (order goes to PreOrder CSV)", "      // Create the pending PreOrder entry (awaiting customer confirmation)");

// Callers: rename the destructured shipment record variable.
s = s.replace("mainOrderCSVData: doc", "shipmentRecord: doc");
s = s.replace(/\bmainOrderCSVData\b/g, "mainOrderDoc");
s = s.replace("// POST /api/orders/finalize/:id  (moves an admin-finalized order to the CSV workflow)", "// POST /api/orders/finalize/:id  (moves an admin-finalized order to the shipment queue)");
s = s.replace("    // The order is now in Main Order CSV — remove the finalized PreOrder\n    // record so it does not linger in the Pre Order CSV / queue.", "    // The order is now in the shipment queue — remove the finalized PreOrder\n    // record so it does not linger in the pending queue.");
s = s.replace('      message: "Order finalized and stored in Main Order CSV Data.",', '      message: "Order finalized and stored in the shipment queue.",');

fs.writeFileSync(file, s);
console.log("ok, lines:", s.split("\n").length, "| createConfirmedOrderExports:", (s.match(/createConfirmedOrderExports/g) || []).length);
