# Kifayat — Broken Logic & Incomplete Workflow Audit

**Mode:** read-only. **Nothing in this repo was changed.** Every item below is diagnosed, not fixed.
**Method:** full static read + automated checks — `node --check` on every backend file, a route→controller
export check, a frontend↔backend route-contract diff, and targeted greps for write/read symmetry.
**Scope:** `kifayat-backend/` and `kifayat-frontend/src/`.

## Automated checks that PASSED (so you know what's *not* wrong)

| Check | Result |
|---|---|
| `node --check` on all backend `.js` (server, 20 controllers, 20 routes, 32 models, 7 middleware, 18 utils, 2 config) | ✅ 0 syntax errors |
| Every handler a route imports is actually exported by its controller | ✅ 0 undefined handlers |
| Every frontend `/api/...` call resolves to a mounted backend route | ✅ 0 mismatches (134 distinct calls) |
| Required env guards, middleware chain, rate limiters mounted | ✅ present |

So the breakage is **semantic**, not structural. Below, ordered by severity.

---

## SEV-1 — `OrderHistory` is never written → the whole post-shipment tracking workflow is dead

**Evidence:** across the entire backend (controllers, utils, routes, scripts) there is **no**
`OrderHistory.create`, `insertMany`, `findOneAndUpdate`, `new`, or `replaceOne`. Grep output is
exclusively **reads** (plus one `updateOne` that pushes `stockAlerts`). The only order records the
confirm/checkout flows create are `PreOrder` + `ShipmentRecord`:

- `createConfirmedOrderExports()` — [orderController.js:152-260](kifayat-backend/controllers/orderController.js#L152-L260) — upserts `PreOrder` and `ShipmentRecord` only, then the caller deletes the daily `Order` + `ShippingDetail`.
- Exactly one `OrderHistory` *write* exists anywhere: `notifyStockAlertCustomers` pushing a `stockAlerts` entry — [outOfStockManager.js:159](kifayat-backend/utils/outOfStockManager.js#L159). That is an update to an already-existing doc, not a create.

**Everything that reads `OrderHistory` is therefore operating on an archive that nothing fills:**

| Consumer | Location | Broken behaviour |
|---|---|---|
| Admin **Order Status** list | `getMainOrderStatusList` — [orderTrackingController.js:110-131](kifayat-backend/controllers/orderTrackingController.js#L110-L131) | List is always empty for real orders |
| Admin **status update** | `updateTrackingStatus` — [orderTrackingController.js:138-197](kifayat-backend/controllers/orderTrackingController.js#L138-L197) | `OrderHistory.findById(id)` → 404 for every live order id (live ids are `ShipmentRecord` ids) |
| Customer **"Your Orders"** progression | `getMyTrackedOrders` — [orderTrackingController.js:201-238](kifayat-backend/controllers/orderTrackingController.js#L201-L238) | Queue orders show `pending` forever (`mapQueue` hardcodes it) and can never become `shipped`/`delivered`, because that transition exists only on `OrderHistory.trackingStatus` |
| Profile **order count / total spent** | `getMe` — [authController.js:626-644](kifayat-backend/controllers/authController.js#L626-L644) | `totalOrdersCount` and `totalSpentAmount` are always 0 |
| Profile **isVerifiedCustomer** promotion (≥15 orders) | [authController.js:626-630](kifayat-backend/controllers/authController.js#L626-L630) | Can never trigger |
| Admin **user** per-user stats | `userController.js:37-42` | Always 0 |
| **Seller analytics** (sales/revenue/recent) | `sellerController.js:284-303` | Always 0 |
| **Receipt** item lookup for `source === "history"` | `receiptController.js:90-99` | `raw?.products` never exists → empty items |

**Root cause:** the HHC/CSV export step (which used to move the shipping queue into `OrderHistory`) was
removed in the manual-catalogue refactor, but the archive write was not re-added to
`createConfirmedOrderExports` / `confirmOrder` / `finalizeOrder`. The readers were left pointing at a
collection that is now write-less.

**Impact:** admin cannot set tracking status; customers never see shipped/delivered; profile, user, and
seller analytics silently report zero.

---

## SEV-2 — Customer "resend confirmation" is permanently broken (id type mismatch)

- Frontend sends the **display** order number: `resendOrderConfirmation(order.order_number)` where `order_number = KFY-<last6 of _id>` — [checkout.tsx:59](kifayat-frontend/src/routes/checkout.tsx#L59), built in [shop.functions.ts:353-360](kifayat-frontend/src/lib/shop.functions.ts#L353-L360).
- Backend matches it against the **ObjectId** field `PreOrder.order` — [orderController.js:1548-1560](kifayat-backend/controllers/orderController.js#L1548-L1560):

  ```js
  PreOrder.findOne({ user: req.user._id, order: orderNumber, status: "pending" })
  ```

`"KFY-ABC123"` can never equal an ObjectId, so it always returns the 404 *"No pending order found with
that number."* The resend button on the order-confirmation screen never works.

---

## SEV-3 — `placeOrder` and the stock gate ignore variations, but the storefront says variations are the source of truth

There are **two contradictory notions of "in stock"** running at once:

- **Storefront / cart (variation-aware):** `productAvailability()` — [productController.js:81-92](kifayat-backend/controllers/productController.js#L81-L92) — sums positive variation quantities when variations exist, else uses `stock`. Used by product list/detail/similar/featured and `validateCart`.
- **Checkout (flat `stock` only):** `placeOrder` decrements the **top-level** `stock` field atomically — [orderController.js:481-495](kifayat-backend/controllers/orderController.js#L481-L495) — and the confirm-time gate checks `product.stock < required` — [orderController.js:1021-1040](kifayat-backend/controllers/orderController.js#L1021-L1040). Neither consults variation quantities.

**Consequences:**
- Product with variations all at 0 but `stock > 0`: storefront shows *out of stock* → checkout still succeeds against `stock`.
- Product with `stock: 0` but variation quantities > 0: storefront shows *in stock* → `placeOrder` rejects with *"Not enough stock"*, and `confirmOrder` routes a legitimate order to `late_confirmation_orders`.
- Out-of-stock auto-deletion triggers on `product.stock === 0` ([orderController.js:552-566](kifayat-backend/controllers/orderController.js#L552-L566)) and in `updateStock` — so a variation product can be deleted while it is actually orderable, or kept forever while every variation is empty.

The "variation-aware availability" claim holds only for read paths; the write/checkout path is flat-stock.

---

## SEV-4 — Stock is restored on pre-order cancels but **not** on any post-confirmation cancel (inventory leak)

| Cancel path | Restores stock? | Location |
|---|---|---|
| 24 h auto-cancel | ✅ yes | `processPreOrderCancellation` — [orderController.js:918-931](kifayat-backend/controllers/orderController.js#L918-L931) |
| Email cancel link | ✅ yes | `cancelOrder` — [orderController.js:1379-1384](kifayat-backend/controllers/orderController.js#L1379-L1384) |
| Workflow cancel-preorder link | ✅ yes | [orderWorkflowController.js:104-110](kifayat-backend/controllers/orderWorkflowController.js#L104-L110) |
| **Customer cancels a queue order** ("Your Orders") | ❌ **no** | `cancelMyOrder` queue branch — [orderTrackingController.js:318-360](kifayat-backend/controllers/orderTrackingController.js#L318-L360) deletes the `ShipmentRecord`, archives to `CancelOrder`, restores vouchers — but never `$inc` stock |
| **Admin cancels via order status** | ❌ **no** | `updateOrderStatus` — [orderController.js:778-833](kifayat-backend/controllers/orderController.js#L778-L833) |
| **Admin system cancel** | ❌ **no** | `adminCancelOrderSystem` + `mainOrderCancellation` — [orderWorkflowController.js:174-260](kifayat-backend/controllers/orderWorkflowController.js#L174-L260), [mainOrderCancellation.js:70](kifayat-backend/utils/mainOrderCancellation.js#L70) |
| **Stock-exhaustion auto-cancel** | ❌ **no** | `notifyStockAlertCustomers` → `cancelMainOrderForStockIssue` — [outOfStockManager.js:100-120](kifayat-backend/utils/outOfStockManager.js#L100-L120) |

Once an order is confirmed into the shipping queue, cancelling it on the backend never returns the
ordered quantity to `Product.stock`. Sold stock permanently disappears from sellable inventory.

---

## SEV-5 — Cancel/exception archives are split across collections and half are unreadable

Two parallel "cancelled order" collections exist and different code writes to different ones:

- **`CancelledOrders`** (written by pre-order cancels): [orderController.js:933](kifayat-backend/controllers/orderController.js#L933), [orderController.js:1391](kifayat-backend/controllers/orderController.js#L1391). Only ever read for a `confirmationToken` lookup — **no admin listing reads it.**
- **`CancelOrder`** (written by queue/admin cancels): [orderTrackingController.js:355](kifayat-backend/controllers/orderTrackingController.js#L355), [orderWorkflowController.js:119](kifayat-backend/controllers/orderWorkflowController.js#L119), [orderWorkflowController.js:207](kifayat-backend/controllers/orderWorkflowController.js#L207), [mainOrderCancellation.js:75](kifayat-backend/utils/mainOrderCancellation.js#L75). The admin **Cancel Orders** page reads **only** `CancelOrder` — [orderWorkflowController.js:329,372](kifayat-backend/controllers/orderWorkflowController.js#L329-L380).

**Result:** pre-order cancellations (the common "customer didn't confirm / cancelled from the emailed
link" case) are archived to `CancelledOrders` and **never surface in the admin cancel-orders panel**.

### Orphaned: `LateConfirmationOrder`
Written exactly once — [orderController.js:1059](kifayat-backend/controllers/orderController.js#L1059) — when confirmation fails the stock gate. There is **no route, controller read, or frontend page** for it anywhere (grep confirms create-only). Late-confirmation orders are emailed to the admin but are otherwise invisible in the app.

---

## SEV-6 — Admin "Orders" and "Order Status" pages can't see the orders that matter

- `getAllOrders` reads the `Order` collection — [orderController.js:741-772](kifayat-backend/controllers/orderController.js#L741-L772). But an `Order` is **deleted** the moment it is confirmed ([orderController.js:1180-1182](kifayat-backend/controllers/orderController.js#L1180-L1182)). So the admin Orders list only ever shows **pending / unconfirmed** orders; confirmed orders live in `ShipmentRecord` and never appear here.
- `getShipments` attaches status by looking the `orderID` up in the (now-deleted) `Order` collection — [shipmentController.js:84-90](kifayat-backend/controllers/shipmentController.js#L84-L90) — so `order?.status` is almost always `undefined` and every shipment is reported as `"confirmed"` regardless of reality.
- `updateOrderStatus` (the admin Orders page action) targets `Order` docs — the same docs that are deleted on confirm — so it cannot change the status of any confirmed order.

Combined with SEV-1, there is currently **no working path for an order to receive a `shipped`/`delivered`
status anywhere in the system.**

---

## SEV-7 — Minor / cosmetic inconsistencies found

1. **Order-number prefixes disagree:** `getShipments`/`getPendingShipments` mint `KP-…`
   ([shipmentController.js:95,213](kifayat-backend/controllers/shipmentController.js#L95)), while the
   frontend mints `KFY-…` ([shop.functions.ts:353](kifayat-frontend/src/lib/shop.functions.ts#L353)) and
   legacy code/docs use `KO-…`. The same order changes its visible id per screen.
2. **`getPublicOrderCount`** sums `Order.countDocuments()` + `ShipmentRecord.countDocuments()` —
   [orderController.js:1536-1546](kifayat-backend/controllers/orderController.js#L1536-L1546). Because a
   confirmed order deletes its `Order` row and adds a `ShipmentRecord` row, the public "orders placed"
   counter is *approximately* stable but not monotonic (it can dip during the confirm window).
3. **`getProductBySlug`** in [shop.functions.ts:150-171](kifayat-frontend/src/lib/shop.functions.ts#L150-L171)
   does a fuzzy name search and returns the *first* result if no slug matches — a silent wrong-product
   risk. (Product pages use `getProductById`, which resolves slug properly, so impact is limited.)
4. **`adminConfirmOrder` drives `confirmOrder` through a hand-rolled fake response object**
   ([orderController.js:1290-1360](kifayat-backend/controllers/orderController.js#L1290-L1360)). It works
   today only because `confirmOrder` doesn't touch `req.get`/`req.headers` on that path — a fragile
   coupling; any future header/URL use inside `confirmOrder` breaks the WhatsApp confirm button.

---

## Cross-reference: how the order lifecycle actually flows today

```
placeOrder  ──► Order(pending) + ShippingDetail + PreOrder(pending, token, 24h)
                    │
     emailed confirm│ (or admin WhatsApp confirm)
                    ▼
confirmOrder ──► stock gate (flat product.stock) ──► createConfirmedOrderExports
                    │                                   ├─ upsert PreOrder(finalized)
                    │                                   └─ upsert ShipmentRecord   ← the live order
                    │  (delete Order + ShippingDetail + PreOrder)
                    ▼
                ShipmentRecord ──► admin "Shipment Details" (read)
                    │
                    ▲  missing step: nothing copies ShipmentRecord → OrderHistory
                    │
                OrderHistory  ──► "Your Orders" progression, admin "Order Status",
                                   profile/user/seller stats, receipt items  (ALL READ-ONLY, EMPTY)
```

The pipeline is intact up to `ShipmentRecord`; everything downstream of the removed archive step is dead.

---

## Suggested fix order (NOT applied — awaiting your go-ahead)

1. **Re-introduce the archive write** in `createConfirmedOrderExports` (populate the structured `products[]`, `user.userId`, `sourceOrderID`, `exportedAt`) so `OrderHistory` is filled on confirm/finalize — this unblocks SEV-1 and much of SEV-6 by itself.
2. **Fix `resendOrderConfirmation`** to accept the display number (or send the id from the client) — SEV-2.
3. **Unify availability**: make `placeOrder`/`confirmOrder`/`updateStock`/out-of-stock use the same variation-aware `productAvailability`, and decide whether variations or flat stock is authoritative — SEV-3.
4. **Centralise cancellation** in one helper so every path restores stock + vouchers and writes one archive collection — SEV-4 + SEV-5.
5. **Surface or delete** `LateConfirmationOrder` and the duplicate cancel collection; align order-number prefixes — SEV-5 + SEV-7.

Items I could **not** fully verify statically (would need a running DB): whether any external job or
manual process populates `OrderHistory`, and the exact runtime behaviour of the `adminConfirmOrder`
fake-`req` coupling.
