# Kifayat — Full Architecture Reference (verified Oct 2026)

> Monorepo (NOT a git repo on this host): `kifayat-backend/` (Express 5 · CommonJS · Node >=22)
> + `kifayat-frontend/` (React 19 · Vite 7 · ESM TS · Node >=20).
> Stack: MERN + Socket.IO + Firebase Auth + Resend/Gmail email + Groq/Gemini AI.
> **No HHC/dropshipping, no CSV export, no tiers, no supplier flow, no OrderHistory.**
> Availability is a per-product admin on/off toggle (`Product.inStock`), not a quantity.

## Run
- Backend: `cd kifayat-backend && npm run dev` (nodemon `server.js`). Requires `MONGODB_URI` + `JWT_SECRET`
  (else `process.exit(1)`). Dev port **3001** (`run_backend.ps1` sets `PORT=3001`; `server.js` defaults 5000).
- Frontend: `cd kifayat-frontend && npm run dev` → Vite port **5000** (`strictPort`).
- Vite dev proxy forwards `/api`, `/uploads`, `/socket.io` → `http://localhost:3001`, rewriting Set-Cookie.
- Health: `GET /api/health` (DB stats + email diagnostics). Prod backend = Northflank; frontend = Cloudflare Pages.

## Backend map
- `server.js` (~1022 lines): env guards → `connectDB()` → **run migrations on boot** (`RUN_MIGRATIONS_ON_BOOT`, default on)
  → **index-drift check** (read-only) → helmet → CORS allowlist → Socket.IO → json/urlencoded → `/uploads` static →
  cookieParser → requestLogger → compression → cache headers → `globalLimiter` → inline sitemaps + robots.txt →
  `/api/health[/firebase|/backups]` → routes → 404 → error handler → graceful shutdown.
  On `listen`: `restorePendingOnStartup` (out-of-stock), `restorePendingPreOrders`, `startVoucherReservationSweeper`,
  `node-cron` daily backup 02:00 Asia/Karachi.
- `config/`: `db.js`, `firebaseAdmin.js` (multi-tier credential loading). **No `tiers.js`.**
- `controllers/` (22): auth, product, productMedia, cart, order, orderQueue, orderTracking, orderWorkflow, shipment,
  voucher, review, websiteReview, receipt, defectiveProduct, interaction, seller, sellerMedia, ai, settings, user,
  userFinalData, activityLog.
- `routes/` (21): mounted in `server.js`. Admin product/order/cart/review/voucher/receipt/defective/interaction routes
  go through `middleware/originGuard.js` (`requireSameOrigin`) for CSRF.
- `models/` (31): User(SignupUsers), Session(UserSessions), RegisterUserData, UserFinalData, Product, Category, Cart,
  Order, PreOrder, ShippingDetail, ShipmentRecord, CancelOrder, CancelledOrders, LateConfirmationOrder, Review,
  WebsiteReview, DiscountVoucher, PurchasedVoucher, CompensationVoucher, DefectiveProductReport, ProductReceipt,
  ProductInteraction, OutOfStockDeletedProduct, Report, ActivityLog, LoginHistory, BlockedUser, DeletedUser,
  TrendingSearch, Settings, Otp.
- `middleware/` (7): auth (`protect`, `softProtect`, `verifySessionToken`), adminProtect (`requireAdmin`),
  sellerProtect, optionalAuth, originGuard, rateLimiters, requestLogger.
- `utils/` (25): jwt, cookies, otp, email, corsConfig, appUrl, logger, activityLogger, loginLogger, sentry, categorize,
  seoKeywords, safeRegex, fileSniffer, heroObjects, indexDrift, voucherRules, voucherLifecycle, compensation,
  mainOrderCancellation, outOfStockManager, groqKey, groqKeyPool, geminiPool, groqProductOptimizer.
- `scripts/` (~45): migrations (`migrate.js`), backups (`backup.js`, `backupScheduler.js`), maintenance/backfill,
  probes, and repair scripts (`repair-legacy-shipment-records.js`, `demo-data.js`). **Not wired into the server** (except
  `migrate.js` and `backup.js`, required at boot/cron).

## Order lifecycle (the core flow)
1. **Place** — `POST /api/orders` (`orderController.placeOrder`): validates each product via `productAvailability`
   (toggle), applies user discount (`customDiscountPercent`) then reserved-voucher discount, increments `salesCount`,
   creates `Order` (pending) + `ShippingDetail` + pending `PreOrder` with a 32-byte `confirmationToken` (24h TTL).
   Reserved voucher uses are converted to **consumed**. `clientRequestId` = idempotency key. Shipping-email OTP gate
   (`/orders/shipping-otp` → `/orders/verify-shipping-otp`). **No stock is decremented** (toggle model).
2. **Confirm** — emailed link `GET /api/orders/confirm/:token` OR admin panel (`adminConfirmOrder`, which calls the same
   handler). Re-checks availability; if OK → `createConfirmedOrderExports` upserts `PreOrder(finalized)` **and**
   `ShipmentRecord` (the live order), deletes `Order` + `ShippingDetail` + `PreOrder`, keeps `confirmationToken` on the
   shipment record, emails the receipt, then **awards loyalty points once** (`awardOrderPoints`, guarded by
   `ShipmentRecord.pointsAwarded`; 5 pts per full Rs 300).
   If product unavailable → archives to `LateConfirmationOrder`, emails customer + admin, deletes the pending rows.
3. **Shipment queue** — `ShipmentRecord` (`shipment_records`) is the single source of truth for a confirmed order:
   numbered product columns (`product1/productName1/…/qty1`…), `trackingStatus`, `user`, `userEmail`, `pointsAwarded`.
4. **Track** — `orderTrackingController.updateTrackingStatus` (admin `PATCH /api/admin/order-status/:id`) writes
   `trackingStatus` + emits `order_status_updated` to `user-<id>` and `admin`. `delivered` burns voucher uses;
   `cancelled` restores them. Customer sees it via `GET /api/orders/tracked`.
5. **Cancel** paths: 24h auto-cancel (`processPreOrderCancellation`), email link (`cancelOrder`), customer
   (`cancelMyOrder`, queue), admin (`updateOrderStatus`, `adminCancelOrderSystem`). All archive to `CancelOrder` /
   `CancelledOrders` and restore voucher uses. **Only the pending-preorder paths restore `stock`** — post-confirm
   cancels do not `$inc` any inventory (moot now that checkout doesn't decrement).
- Admin order queues: `GET /api/admin/order-queue/unconfirmed` (pre_orders) and `/confirmed` (shipment_records);
  `GET /api/admin/shipments` = "Shipment Details"; `POST /api/admin/shipments/:orderId/confirm` = WhatsApp confirm.
- **Order-number prefix is `KP-` + last 8 of the ObjectId** everywhere in the admin panel.

## Product & catalogue
- `Product.productId` = `kp-00000000001` minted atomically from `Settings.productSequence`.
- `Product` requires **>=3 images and 1 video** (admin form / seller form). `costPrice` is private (`toPublicObject`).
- **Availability = `productAvailability()`** in `productController.js`: if `variations[]` exist → in stock when any
  variation `inStock !== false`; else `inStock` boolean (falls back to legacy `stock > 0`). `toCustomerProduct()` strips
  `stock`/`costPrice`/`hidden`/variation quantities and exposes only `inStock`.
- `PATCH /api/products/:id/stock` sets the toggle (`inStock`), mirrors legacy `stock` 1/0, sets `stockOutAt`.
- Public list cache: 30s in-memory (`LIST_CACHE_TTL`), cleared on every mutation. Correctness = `LIST_PROJECTION`.
- Categorization (`utils/categorize.js`) is a deterministic keyword scorer; SEO keywords (`utils/seoKeywords.js`)
  deterministic. AI copy uses the Groq/Gemini key pools (fast tasks Gemini-first, Groq fallback, batches ≤12).
- ⚠️ **`utils/outOfStockManager.js` is now ORPHANED**: `scheduleDeletion` is only called by its own `restorePendingOnStartup`,
  and nothing sets `pendingDeleteAt` anymore (the toggle refactor removed the numeric-stock trigger). The 2-minute
  auto-delete-to-`OutOfStockDeletedProduct` pipeline therefore never fires. Decide: re-wire it or remove it.

## Auth & accounts
- Email: register → SHA-256 OTP (10 min) → verify → session. Passwords bcrypt cost 12.
- Google: frontend Firebase popup → ID token → `POST /api/auth/google` → `verifyFirebaseToken` → upsert → session.
- `issueSession`/`getMe` re-evaluate role from `ADMIN_EMAILS` (promote-only; `faiza@kifayat.co` is hard-coded `seller`).
- Cookie `kifayat_token` (httpOnly, 30d, Secure+SameSite=None in prod) + `Session` collection (TTL). JWT has a nonce so
  two logins in the same second don't collide. `protect` = cookie → JWT → Session → User exists+verified.
- Password / email / order-conf-email changes are OTP-gated. `toSafeObject()` strips secrets.
- `getMe` computes `totalOrdersCount`/`totalSpentAmount` from `ShipmentRecord`; promotes `isVerifiedCustomer` at 15 orders.

## Vouchers & loyalty
- Admin publishes `DiscountVoucher` → user buys with `loyaltyPoints` → `PurchasedVoucher` (conditions snapshotted).
- Conditions (`utils/voucherRules.js`): discount_type percent|amount, product_quantity, **min_units** (unit rule),
  price_min/max, expiry. Both apply-endpoint and checkout price through the same helpers.
- Lifecycle (`utils/voucherLifecycle.js`): apply = `reserved`; order placed = `consumed`; failed order = released;
  cancelled = restored; delivered = burned. A 48h sweeper releases stale reservations.
- DB unique **partial** index `{user, applied_products.product}` (migration 001) enforces one voucher use per product/user.

## Socket.IO
- Server allows polling + websocket; the **client is polling-only**. Handshake token from `handshake.auth.token` or the
  cookie. Anonymous allowed (`socket.data.user=null`); an invalid token rejects. Auto-join `user-<id>`; admins join `admin`.
- Events: `products_updated`, `product_out_of_stock`, `product_deleted`, `products_cleared`, `recategorize_progress`,
  `order_status_updated`, `order_cancelled`, `order_product_out_of_stock`, `loyalty_points_awarded`,
  `receipt_submitted|approved|rejected`, `chat:message|error`.

## Frontend map
- `src/routes/` file-based TanStack Router (storefront + `_authenticated/admin.*` (21 pages) + `seller.*`). Client-side
  guard only (`_authenticated/route.tsx` → `GET /auth/me`). 404/error/pending in `__root.tsx`.
- `src/lib/api.ts` — single `fetch` wrapper (`credentials:"include"`, BASE `/api`) + `normalizeProduct()` (Mongo→`UIProduct`).
  `lib/*.functions.ts` are plain async call wrappers (shop, admin, account, analytics, seller-analytics, reviews, search,
  voucher, receipt).
- Stores (hand-rolled observables, no Zustand): `auth-store` (`/auth/me`), `cart-store` (localStorage `kifayat.cart.v1`;
  line key `slug::variation`; `refreshCartPrices`/`validateCartStock`/`fetchDeliveryFee`/`cartTotals`; mirrors backend
  pricing: user discount → voucher), `ui-store`, `seller-store`. Wishlist is localStorage only.
- `hooks/`: `use-realtime-sync` (invalidate product queries), `use-order-status-sync`, `use-receipt-*`, `use-active-time`.
- Build: `npm run build` = generate-sitemaps → ping-indexnow → vite build → prerender (Playwright). SEO via
  `react-helmet-async` + `components/seo/`. Cloudflare Pages `functions/` proxy `/api`+`/socket.io` to `BACKEND_ORIGIN`;
  `functions/middleware.ts` maintenance mode is ON unless `MAINTENANCE_ENABLED=false`.

## Conventions when coding here
- Backend responses are `{ success, message?, ...data }`. CommonJS, handlers `const name = async (req,res)`.
  Validate with Joi; sanitize regex with `utils/safeRegex`. Never leak `costPrice`/`stock`/PII.
- State-changing admin/auth routes need `protect` + role guard + `requireSameOrigin` (+ limiter when sensitive).
- Broadcast with `io` and update the matching frontend hook. Respect the toggle-based availability (don't reintroduce
  quantity math). Frontend: add API calls to the relevant `lib/*.functions.ts`, normalize products through `normalizeProduct`.
- **Migrate** schema/index changes via a new step in `scripts/migrate.js` (idempotent, recorded in `migrations`); boot runs it.

## Stale docs to distrust
- `.agents/memory/kifayat-dynamic-data-sync.md`, `kifayat-csv-lifecycle.md`, `kifayat-backend-audit.md`, and the root
  `KIFAYAT_BACKEND_AUDIT.md` describe deleted HHC/CSV/tier/supplier/OrderHistory worlds.
- Root `CODEBASE-ANALYSIS.md` and `BROKEN-LOGIC-AUDIT.md` are mostly current but predate the availability-toggle refactor
  and the OrderHistory removal; verify against code.
