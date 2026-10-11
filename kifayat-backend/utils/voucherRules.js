/**
 * Voucher conditions — one single source of truth.
 *
 * A voucher may only be applied to a product that satisfies EVERY condition
 * written on it:
 *
 *   • price range   — the product's price must fall inside [price_min, price_max]
 *   • product quota — the customer may apply it to at most `product_quantity`
 *                     products
 *   • unit rule     — when the voucher names `min_units`, the cart line must
 *                     hold at least that many units of the product. 1 means
 *                     "no unit rule" and is the default for every voucher.
 *   • expiry        — it must not be past `expires_at`
 *   • restrictions  — a gifted voucher only works on the products written on it
 *
 * Both the "apply to a product" endpoint and checkout pricing use these
 * helpers, so the storefront can never show a discount the server rejects.
 */

/** Normalize an admin-entered price bound: blank/"any" → null (unbounded). */
function toPriceBound(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** How many products this voucher may be applied to (at least 1). */
function voucherProductQuantity(voucher = {}) {
  const q = Number(voucher.product_quantity ?? voucher.max_uses);
  return Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
}

/**
 * Minimum units of one product required for this voucher to apply.
 * Always >= 1; 1 means the voucher has no unit rule.
 */
function voucherMinUnits(voucher = {}) {
  const q = Number(voucher.min_units);
  return Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1;
}

/** The discount this voucher grants, as a display label: "10% off" / "Rs 250 off". */
function voucherDiscountLabel(voucher = {}) {
  if (voucher.discount_type === "amount") {
    const amount = Number(voucher.discount_amount) || 0;
    return `Rs ${amount.toLocaleString("en-PK")} off`;
  }
  return `${Number(voucher.discount_percent) || 0}% off`;
}

/**
 * Apply the voucher's discount to a unit price.
 * Percent is applied multiplicatively on top of the user-level discount;
 * a rupee amount is subtracted and clamped at zero.
 */
function applyVoucherDiscount(unitPrice, voucher = {}) {
  const base = Math.max(0, Number(unitPrice) || 0);
  if (voucher.discount_type === "amount") {
    return Math.max(0, Math.round(base - (Number(voucher.discount_amount) || 0)));
  }
  const pct = Number(voucher.discount_percent) || 0;
  if (pct <= 0) return base;
  return Math.max(0, Math.round(base * (1 - pct / 100)));
}

/**
 * Check a catalogue product against the voucher's own conditions.
 * Returns { ok, reason } — `reason` is customer-facing.
 */
function productSatisfiesVoucher(voucher = {}, product = {}, quantity = null) {
  const price = Number(product.salePrice ?? product.price ?? 0) || 0;
  const min = toPriceBound(voucher.price_min);
  const max = toPriceBound(voucher.price_max);

  // Unit rule — only checked when a quantity is known (checkout/cart). The
  // "apply to a product" step happens before a quantity exists, so it stays
  // permissive and checkout remains the authoritative gate, exactly like the
  // price-range rule above.
  const minUnits = voucherMinUnits(voucher);
  if (minUnits > 1 && quantity !== null && quantity !== undefined) {
    const qty = Math.floor(Number(quantity) || 0);
    if (qty < minUnits) {
      return {
        ok: false,
        // `code` lets callers tell the two kinds of failure apart: the unit
        // rule is fixable by editing the cart, a price-range miss is not.
        code: "unit_rule",
        reason: `This voucher needs at least ${minUnits} units of the same item. Add ${
          minUnits - qty
        } more to use it.`,
      };
    }
  }

  if (min !== null && max !== null && price < min) {
    return {
      ok: false,
      code: "price_range",
      reason: `This voucher is only valid on products from Rs ${min.toLocaleString("en-PK")} to Rs ${max.toLocaleString("en-PK")}.`,
    };
  }
  if (min !== null && max === null && price < min) {
    return {
      ok: false,
      code: "price_range",
      reason: `This voucher is only valid on products priced Rs ${min.toLocaleString("en-PK")} or more.`,
    };
  }
  if (max !== null && price > max) {
    return {
      ok: false,
      code: "price_range",
      reason: `This voucher is only valid on products priced up to Rs ${max.toLocaleString("en-PK")}.`,
    };
  }

  return { ok: true, reason: "", code: null };
}

/** Human-readable summary of a voucher's conditions (admin + customer UIs). */
function voucherConditionSummary(voucher = {}) {
  const min = toPriceBound(voucher.price_min);
  const max = toPriceBound(voucher.price_max);
  let priceRange = "Any price";
  if (min !== null && max !== null) {
    priceRange = `Rs ${min.toLocaleString("en-PK")} – Rs ${max.toLocaleString("en-PK")}`;
  } else if (min !== null) {
    priceRange = `Rs ${min.toLocaleString("en-PK")} and above`;
  } else if (max !== null) {
    priceRange = `Up to Rs ${max.toLocaleString("en-PK")}`;
  }
  const minUnits = voucherMinUnits(voucher);
  return {
    discount: voucherDiscountLabel(voucher),
    productQuantity: voucherProductQuantity(voucher),
    // 1 = no unit rule; the UIs render `unitRule` only when it is non-empty.
    minUnits,
    unitRule: minUnits > 1 ? `Needs ${minUnits}+ units of the same item` : "",
    priceRange,
    priceMin: min,
    priceMax: max,
  };
}

module.exports = {
  toPriceBound,
  voucherProductQuantity,
  voucherMinUnits,
  voucherDiscountLabel,
  applyVoucherDiscount,
  productSatisfiesVoucher,
  voucherConditionSummary,
};
