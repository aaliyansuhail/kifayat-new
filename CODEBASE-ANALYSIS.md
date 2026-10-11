# Kifayat — Full Codebase Analysis

> Generated as a working reference so future changes can be made quickly and safely.
> Covers `kifayat-backend/` and `kifayat-frontend/` as they exist on disk.

---

## 1. What this project is

**Kifayat** is a full-stack e-commerce platform ("Pakistan's Editorial Marketplace") with
three audiences in one codebase:

- **Storefront** — editorial landing page + catalogue + product pages + cart + COD checkout.
- **Customer account** — auth (email OTP + Google), orders, tracked orders, addresses, vouchers, reviews, wishlist.
- **Admin + Seller suite** — dashboard, products, orders, shipments, users, vouchers, reviews, receipts, defective-product chat, AI Studio.

Two independent npm projects sit side by side (there is **no root git repo** discovered on this host):

```
├── kifayat-backend/    Express 5 · Mongoose 9 · Socket.IO      (CommonJS, Node >=22)
├── kifayat-frontend/   React 19 · Vite 7 · TanStack Router     (ESM TS, Node >=20)
├── *.md                ops/audit docs (some STALE — see §9)
├── run_backend.ps1     Windows helper: PORT=3001 then npm start
└── run_frontend.ps1    Windows helper: npm run dev
```

### Runtime topology

```
Browser ──► Vite dev (port 5000) ──proxy /api,/socket.io,/uploads──► backend :3001
Production:
Browser ──► Cloudflare Pages (static dist/) ──Pages Functions──► Northflank backend
```

- **Backend dev port:** `3001` (server.js defaults to `5000`, but `run_backend.ps1` sets `PORT=3001`; the Vite proxy targets `http://localhost:3001`). **Backend prod:** Northflank, health check `GET /api/health`.
- **Frontend dev:** Vite on `5000` (`strictPort`). **Prod:** Cloudflare Pages, built by GitHub Actions, proxying API via `functions/`.

---

## 2. Backend (`kifayat-backend/`)

### 2.1 Shape

| Dir | Files | Notes |
|---|---|---|
| `server.js` | 1 (948 lines) | App bootstrap, middleware chain, Socket.IO, sitemaps, startup jobs |
| `routes/` | 20 | Thin routers; mount auth + role guards + `originGuard` |
| `controllers/` | 20 | All business logic (~10.7k lines) |
| `models/` | 32 Mongoose models (~1.5k lines) | |
| `middleware/` | 7 | auth, optionalAuth, adminProtect, sellerProtect, originGuard, rateLimiters, requestLogger |
| `utils/` | 18 | JWT, cookies, OTP, email, key pools, categorization, out-of-stock, voucher lifecycle, logging |
| `config/` | 2 | `db.js`, `firebaseAdmin.js` |
| `scripts/` | 40+ | Maintenance/backfill/probe scripts — **not wired into the server** |

### 2.2 Boot sequence (`server.js`)

1. `dotenv` + global `unhandledRejection` / `uncaughtException` handlers (Sentry capture).
2. **Startup guards:** `MONGODB_URI` and `JWT_SECRET` are required (exit if missing). Warns about email provider, `ADMIN_EMAILS`, and production `PUBLIC_APP_URL`.
3. `connectDB()` — Mongoose connect; exits on failure.
4. Express app with `trust proxy = 1`.
5. **Middleware order:** helmet (`crossOriginOpenerPolicy: same-origin-allow-popups` so Google popups work) → optional Sentry → CORS allowlist → Socket.IO → `express.json/urlencoded` (10 MB) → static `/uploads` → `cookieParser` → `requestLogger` → `compression` → Cache-Control + security headers → `globalLimiter`.
6. **Sitemaps** rendered inline: `/sitemap.xml` (index), `/sitemap-pages.xml`, `/sitemap-products.xml`, `/sitemap-categories.xml`, `/image-sitemap.xml`, `/robots.txt`. Canonical host pinned to `https://www.kifayat.co` via `utils/appUrl.js`.
7. **Health:** `/api/health` (DB stats + system metrics + email status), `/api/health/firebase`, `/api/health/backups`.
8. **Routes mounted** (see §2.4).
9. 404 JSON handler + global error handler (CORS→403, bad JSON→400, oversized file→413, else 500).
10. Graceful shutdown on SIGINT/SIGTERM.
11. **On `listen`:** `restorePendingOnStartup` (out-of-stock timers), `restorePendingPreOrders`, `startVoucherReservationSweeper`, and a `node-cron` daily backup at 02:00 Asia/Karachi.

### 2.3 Socket.IO

- Server allows both polling and websocket (the **client** locks to polling).
- Handshake auth: token from `socket.handshake.auth.token` **or** the `kifayat_token` cookie → `verifySessionToken`. Anonymous allowed (`socket.data.user = null`); an **invalid token rejects the connection**.
- On connect: joins `user-<id>`; admins also join `admin`.
- Client can emit `chat:join` / `chat:leave` for a `defective-<reportId>` room (owner or admin only, validated).

**Server → client events (the realtime contract):**

| Event | Emitted from | Payload intent |
|---|---|---|
| `products_updated` | productController | create/update/restore/recategorize/out-of-stock cleanup |
| `product_out_of_stock` | productController, orderController | product hit zero stock |
| `product_deleted` | productController, outOfStockManager | product removed |
| `products_cleared` | productController | full wipe |
| `recategorize_progress` | productController | background job progress |
| `order_status_updated` | orderTrackingController, orderController | to `user-<id>` + `admin` |
| `order_cancelled` | orderTrackingController | to `user-<id>` + `admin` |
| `order_product_out_of_stock` | outOfStockManager | customer stock alert |
| `loyalty_points_awarded` | orderController | to `user-<id>` |
| `receipt_submitted` / `receipt_approved` / `receipt_rejected` | receiptController | admin / customer |
| `chat:message` / `chat:error` | defectiveProductController | report chat |

### 2.4 API surface (route → controller)

**Auth** (`/api/auth`, `authRoutes.js` → `authController.js`)
`register`, `verify-otp`, `resend-otp`, `login`, `google`, `logout`, `heartbeat`, `me` (softProtect), `profile`/`update`, `verify-email-update`/resend, `send-delete-otp`/`account` (DELETE), `password`/`update-password`/`verify-password-update`, `forgot-password`, `reset-password`, `order-con-email` + verify/resend, `shipment-emails` (list/send-otp/verify-otp/remove), and `POST /avatar` (multipart, magic-byte sniffed).

**Products** (`/api/products`, `productRoutes.js` → `productController.js`)
Public: `GET /` (list/search/filter/sort/paginate), `/suggest`, `/trending-searches`, `/categories`, `/featured-landing`, `/:id` (resolves `_id`|`productId`|`slug`), `/:id/similar`.
Admin: `/admin-list`, `/stats`, `/leaderboard`, `/out-of-stock`, `/featured-count`, `/deleted`, `POST /manual`, `DELETE /`, `/recategorize-all(-keywords)`, `/recategorize-status`, `PUT /featured-order`, `/manual-positions/bulk`, `DELETE /manual-positions`, `POST /upload-media`, `PUT/DELETE /:id`, `PATCH /:id/stock`, `PUT /:id/featured-landing`, `PATCH /:id/manual-position`, `PATCH /:id/restore`, `GET /:id/orders`, `PUT /categories/update-image`.

**Cart** (`/api/cart`, protect): `GET /`, `POST /`, `POST /validate` (price + stock re-validation, variation-aware).

**Orders** (`/api/orders`)
Public token links: `GET /confirm/:token`, `GET /cancel/:token`; public `GET /count`.
Auth: `POST /shipping-otp`, `/verify-shipping-otp`, `POST /` + `/place`, `GET /my`, `/tracked`, `POST /tracked/:id/cancel`, `/resend-confirmation/:orderNumber`, `GET /by-request/:clientRequestId`.
Admin: `GET /preorders`, `GET /`, `PATCH|PUT /:id/status`, `POST /finalize/:id`.

**Others:** `/api/workflow` (preorder confirm/cancel, cancel-orders, cancel-system), `/api/reviews`, `/api/website-reviews`, `/api/vouchers`, `/api/receipts`, `/api/defective-products`, `/api/interactions` (`POST /track`, own limiter), `/api/seller`, `/api/admin/*` (users, activity-logs, order-status, shipments, users-final-data, settings, ai), `/api/settings/public` (unauthenticated delivery fee + hero objects).

### 2.5 Middleware / security

- **Auth** (`middleware/auth.js`): `protect` reads `kifayat_token` cookie → `verifyToken` → `Session` lookup (rejects `loggedOutAt`, TTL-expired sessions are auto-purged) → `User` must exist and be `isVerified`. `softProtect` never 401s (used by `/me`). `verifySessionToken` is shared with Socket.IO.
- **Roles:** `requireAdmin` requires `role==="admin"` **and** email in `ADMIN_EMAILS`; `requireSeller` allows `seller` or `admin`.
- **CSRF:** `originGuard` (a.k.a. `requireSameOrigin`) blocks `Sec-Fetch-Site: cross-site` on admin/orders/cart/reviews/vouchers/receipts/defective/interactions routes.
- **Rate limits** (`rateLimiters.js`): global 5000/15m, auth 15/15m, OTP 6/15m, orders 10/15m, token links 10/15m, AI 30/15m, interactions 240/min.
- **Cookies:** `kifayat_token`, httpOnly, 30d, `secure` + `SameSite=None` in production, `Lax` in dev. Vite rewrites `Secure`/`SameSite` on the proxy so dev over HTTP still works.
- **CORS:** explicit allowlist (`utils/corsConfig.js`) — localhost ports + `www.kifayat.co` + `CORS_ORIGINS` env. Any `127.0.0.1:<port>` allowed for preview. No wildcards.
- **JWTs** carry a random nonce so two sessions in the same second don't collide on the unique `Session.token`.

### 2.6 Data model (32 collections)

Core: `SignupUsers` (User), `UserSessions`, `Otp`, `cart`, `products`, `Category`, `orders`, `pre_orders`, `shipment_records`, `OrderHistory`, `reviews`, `WebsiteReview`, `ShippingDetail`.
Vouchers: `discount_vouchers`, `purchased_vouchers`, `CompensationVoucher`.
Ops/moderation: `activity_logs`, `LoginHistory`, `BlockedUser`, `DeletedUser`, `Report`, `DefectiveProductReport`, `ProductReceipt`, `OutOfStockDeletedProduct`, `CancelledOrders`, `CancelOrder`, `LateConfirmationOrder`, `Settings`, `TrendingSearch`, `ProductInteraction`, `UserFinalData`, `RegisterUserData`.

Notable schema decisions:
- **`Product.costPrice`** is private; `toPublicObject` strips it. `stock` is stripped from customer payloads — only `inStock` is exposed (`toCustomerProduct` / `productAvailability`).
- **Variations win for availability:** if `variations[]` exist, `inStock` = sum of positive `quantity`; otherwise `stock > 0`. This is the single source of truth across list/detail/similar/featured/cart.
- **Public product id** `kp-00000000001…` minted atomically from `Settings.productSequence`.
- **Vouchers** have a per-use lifecycle (`applied_products[]` with `reserved`/`consumed`) plus a DB-level unique index `{user, applied_products.product}` enforcing "one voucher use per product per user".
- **`ShipmentRecord`** stores numbered denormalized columns (`product1`, `productName1`, `qty1`, …) with `strict:false`; `OrderHistory` is the immutable archive that powers customer tracking.

### 2.7 Order lifecycle (the most complex flow)

1. **Place** (`placeOrder`): per-item **atomic** `findOneAndUpdate({stock:{$gte:qty}}, {$inc:{stock:-qty}})` (no oversell) → create `Order` + `ShippingDetail` + pending `PreOrder` with a 32-byte `confirmationToken` (24h). Optional `clientRequestId` idempotency check. Shipping-email OTP gate before placing.
2. **Confirm** (emailed link → `GET /orders/confirm/:token`, or admin panel): `createConfirmedOrderExports` upserts `PreOrder` (finalized) + `ShipmentRecord`, deletes the pending Order/ShippingDetail, awards **loyalty points exactly once** (`pointsAwarded` guard), and emits realtime events. An in-memory 24h timer auto-cancels unconfirmed pre-orders (re-armed on boot by `restorePendingPreOrders`).
3. **Finalize / ship** (`finalizeOrder`, admin): moves the order into the shipment queue, removes the PreOrder.
4. **Track** (`orderTrackingController`): `updateTrackingStatus` writes `OrderHistory.trackingStatus` and pushes `order_status_updated` to the customer + admin; `getMyTrackedOrders` merges queue + archive for "Your Orders".
5. **Cancel** — several paths (`cancelOrder` token link, `cancelMyOrder`, `adminCancelOrderSystem` with a real Mongo transaction, stock-issue auto-cancel). All restore voucher uses via `utils/voucherLifecycle.js`; stock restore is inconsistent across admin paths (see §9).

### 2.8 Product / catalogue pipeline

- `getProducts`: `$text` search → `$regex` fallback; category filter resolves `Category.slug` + keyword map; price/brand/seller filters; 30s in-memory list cache (max 500 entries); `toCustomerProduct` strips private fields. Fires-and-forgets a `TrendingSearch` upsert.
- **Out-of-stock → deletion** (`utils/outOfStockManager.js`): when stock hits 0, the product is scheduled for deletion after **2 minutes** (`.pendingDeleteAt`), archived to `OutOfStockDeletedProduct`, removed from `products`, and `notifyStockAlertCustomers` runs: queue orders are **auto-cancelled** (archived to cancel_orders, voucher uses restored, customer emailed) while already-exported orders just get a persisted `stockAlert`. Timers are restored on boot.
- Cron-less recategorization runs as background jobs in `productController` / `aiController` with in-memory state + `recategorize_progress` socket events.
- **Categorization** (`utils/categorize.js`) is a deterministic keyword scorer (6 categories, strong=3 / weak=1, name weighted 3×). `utils/seoKeywords.js` generates deterministic SEO keywords (no AI).

### 2.9 Auth flows

- **Email:** register → SHA-256-hashed OTP (10 min) → `verify-otp` → session. Passwords: bcrypt cost 12.
- **Google:** frontend Firebase popup → ID token → backend `verifyFirebaseToken` (Firebase Admin, multi-priority service-account loading) → user upsert → session.
- **Session issue** re-evaluates role from `ADMIN_EMAILS` (promote-only, never demote) and writes a `Session` + login history + activity log.
- Password/email/order-conf-email changes are all OTP-gated (separate `pending*` fields on `User`).
- `toSafeObject()` strips password, OTPs, firebaseUID, customDiscountPercent.
- **Account deletion** also removes the Firebase user (best-effort) and records `DeletedUser`.

### 2.10 Vouchers & loyalty

- `DiscountVoucher` (admin-generated) → user `buyVoucher` (spends `loyaltyPoints`) → `PurchasedVoucher`.
- `applyVoucher` creates a **reserved** use; placing an order converts it to **consumed**; cancelling/failing releases it; delivering burns it (`utils/voucherLifecycle.js`). A **reservation sweeper** releases stale reservations.
- `utils/compensation.js` + `CompensationVoucher` handle admin-issued compensation vouchers.

### 2.11 AI pipeline

- Two key pools, both DB-first (`Settings.groqApiKeys` / `geminiApiKeys`) then env fallback:
  - `utils/geminiPool.js` — `gemini-2.5-flash-lite`, ~230k TPM/key, JSON mode.
  - `utils/groqKeyPool.js` — `llama-3.1-8b-instant` (fast tasks) / `llama-3.3-70b-versatile` (analysis), ~5.5k TPM + 25 RPM per key.
- Router (`chatWithRetry`): **fast tasks** (descriptions/titles/seo/categories/duplicates) try Gemini first (20s budget) then fall back to the Groq fleet; big batches split into ≤12-item chunks. Per-key health, cooldowns, invalid-key disabling, real-token pacing.
- Admin AI Studio jobs (`aiController.js`): Description Doctor, Title Optimizer, Review Intelligence, Duplicate Radar, SEO Booster, Category Fixer, Pool Status, Hide Product. Jobs keep in-memory state exposed via `/status` endpoints.

### 2.12 Email, logging, backups, Sentry

- `utils/email.js` (654 lines): Resend primary / Gmail SMTP fallback, HTML templates (OTP, order confirm/link, late confirm, stock alert, admin notify). Provider status surfaced at `/api/health`.
- `utils/logger.js` — Winston with daily rotation; `utils/activityLogger.js` — admin audit trail; `utils/loginLogger.js` — login history + throttled `lastActiveAt`.
- `scripts/backup.js` + `backupScheduler.js`: daily MongoDB dumps at 02:00, status at `/api/health/backups`. DISASTER_RECOVERY.md documents restore.
- Sentry is opt-in (only when `SENTRY_DSN` + production).

---

## 3. Frontend (`kifayat-frontend/`)

### 3.1 Shape

Stack: **React 19**, **Vite 7**, **TanStack Router** (file-based, `autoCodeSplitting`), **TanStack Query**, **Tailwind CSS 4**, Radix/shadcn components, Framer Motion, Lenis, Recharts, Leaflet, Sonner, Socket.IO client, Zod, react-hook-form, Firebase (Google sign-in), Sentry.

```
src/
├── routes/          56 route files (storefront + /_authenticated/admin.* + seller.*)
├── components/      landing, shop, motion, seo, trust, admin, seller, ui (shadcn)
├── lib/             26 modules (api, stores, *.functions.ts, firebase, socket, format…)
├── hooks/           7 (realtime/order/receipt sync, active time, mobile)
├── services/        1 (geocoding)
├── styles/          index.css, auth.css, dashboard.css
└── test/            vitest setup + example
functions/           Cloudflare Pages Functions (proxy + maintenance)
scripts/             generate-sitemaps.mjs, ping-indexnow.mjs, prerender.mjs, seo-config.mjs
e2e/                 Playwright basic.spec.ts
```

### 3.2 Routing & auth gating

- `__root.tsx`: mounts `SmoothScroll` (Lenis), `ScrollToTop`, `PageTransition`, `Toaster`, `FlyToCart`, and the realtime hooks. Has 404/error/pending components.
- `_authenticated/route.tsx`: `beforeLoad` calls `/auth/me`, redirects to `/auth` when unauthenticated; renders the storefront shell except for `/admin/*`.
- Admin pages live under `_authenticated/admin.*`; seller pages under `_authenticated/seller.*`.
- **Route guard is client-side only** — real authorization is enforced server-side.

### 3.3 Data layer

- `lib/api.ts` — thin `fetch` wrapper (`credentials: "include"`, JSON), plus `normalizeProduct()` mapping Mongo docs → `UIProduct` (handles `gallery`/`images`/`videos`, derives badges, hides `costPrice`-adjacent noise, `inStock`). **Comment says "proxied to localhost:5000" — stale; backend dev is 3001.**
- `lib/*.functions.ts` are **plain async wrappers over `/api`** (NOT TanStack server functions despite the name): `shop`, `admin`, `account`, `analytics`, `seller-analytics`, `reviews`, `search`, `voucher`, `receipt`.
- **Stores** (hand-rolled observable modules, no Zustand):
  - `auth-store.ts` — `/auth/me` on mount, `useAuth()`, `signOut()`, `refreshAuth()`.
  - `cart-store.ts` — localStorage (`kifayat.cart.v1`), line key = `slug::variation`, user + voucher pricing math, `refreshCartPrices`, `validateCartStock`, `fetchDeliveryFee`, `cartTotals`.
  - `ui-store.ts` — drawer via `useSyncExternalStore`. `seller-store.ts` — branding constants.
  - Wishlist is **localStorage-backed** (`kifayat.wishlist.v1` in `lib/account.functions.ts` — the backend has no wishlist collection) and surfaced via `WishlistButton` / `account.wishlist`.
- `lib/firebase.ts` — lazy Firebase init + `signInWithGoogle` (retries once on failure).
- `lib/socket.ts` — singleton socket, polling-only, `autoConnect:false` + deferred connect on idle, backoff.

### 3.4 Realtime hooks (mounted in `__root`)

- `use-realtime-sync.ts` — invalidates product query caches on the four product events + toasts.
- `use-order-status-sync.ts` — live `order_status_updated` / `order_product_out_of_stock` with **ownership checks** (`userId`/email) and de-dupe; plus a "visit" diff using localStorage last-seen maps.
- `use-receipt-status-sync.ts`, `use-receipt-notifications.ts`, `use-admin-cancel-notifications.ts` — receipt + admin cancel events.
- `use-active-time.ts` — 5-min heartbeat while the tab is visible, for admin "time stats".

### 3.5 Storefront & admin surface

- Landing components: Hero, FlashDeals, Products/Featured, Categories, Lookbook, FounderLetter, Founders, EditStory, PressStrip, Testimonials, LiveStats, Newsletter, Header/MobileNav/SideDrawer, Footer, ValueStrip, LegalPage.
- Product page (`products.$productId.tsx`, 1194 lines): gallery/lightbox, video, variants, similar products, reviews/QA, wishlist, engagement tracking.
- Checkout (`checkout.tsx`): address autocomplete (`AddressAutocomplete.jsx` + `LocationPicker.jsx` + Leaflet), shipping-email OTP, COD, idempotent order placement, confirmation.
- Admin suite: 20 admin routes (dashboard, products, add-product, featured, product-hunting, orders, order-status, shipments, receipts, users, user-data, vouchers, reviews, website-reviews, defect-reports, deleted-products, activity-logs, ai, settings) + seller (index, products with `ProductForm.tsx` + `EngagementAnalytics.tsx`).

### 3.6 Build, SEO & deploy

- `npm run build` = `generate-sitemaps.mjs` → `ping-indexnow.mjs` → `vite build` → `prerender.mjs` (Playwright prerenders storefront against the public backend). Manual chunks split vendor libs.
- `index.html` + `react-helmet-async` + `components/seo/SEO.tsx` / `JsonLd.tsx` provide per-route meta/JSON-LD.
- **Cloudflare Pages Functions:**
  - `functions/_backend.ts` — `proxyToBackend` (streams body/headers to `BACKEND_ORIGIN`, no-store, 502 on failure).
  - `functions/api/[[path]].ts` → proxies `/api/*`; `functions/socket.io/[[path]].ts` → proxies socket upgrades.
  - `functions/middleware.ts` — **MAINTENANCE MODE IS ON BY DEFAULT**: every request except `/maintenance.html` is 302-redirected to `/maintenance.html` unless `MAINTENANCE_ENABLED === "false"`. **This must be set to false (or edited) in the Pages dashboard for the site to serve.**
- `public/_headers` sets HSTS, CSP, `X-Frame-Options: DENY`, and no-store for API/socket/uploads. `public/_redirects` falls back SPA → `/index.html`.
- CI: `.github/workflows/deploy-frontend.yml` builds with Node 22, installs Playwright Chromium, fails the build unless the homepage has **≥60** prerendered `<article>` cards.
- `wrangler.toml`: `pages_build_output_dir = "dist"`, compatibility date `2026-09-21`.

---

## 4. Cross-cutting flows (end to end)

**Google sign-in:** `firebase.ts signInWithGoogle` → ID token → `POST /api/auth/google` → Firebase Admin verify → user upsert → `issueSession` sets cookie → `refreshAuth()`.

**Checkout:** cart-store → `refreshCartPrices` + `validateCartStock` → shipping-email OTP → `createOrder` (`POST /orders`) → backend atomic stock decrement + Order/PreOrder → confirmation email link → `GET /orders/confirm/:token` → shipment record + loyalty points + socket events → tracked order status updates.

**Admin product edit:** `admin.functions.ts` → `/api/products/:id` → `updateProduct` (validates ≥3 images + 1 video, regenerates slug/keywords, schedules out-of-stock deletion) → emits `products_updated` → `useRealtimeSync` invalidates caches everywhere.

**Voucher apply at checkout:** frontend applies locally for display → backend `applyVoucher` reserves → `placeOrder` consumes → cancel restores / deliver burns.

---

## 5. Conventions to follow when coding

**Backend**
- CommonJS (`require`/`module.exports`); handlers are `const name = async (req, res) => {}`; shared modules export an object at the bottom.
- Responses are always `{ success: boolean, message?, ...data }`; errors use appropriate HTTP status + `message`.
- Validate input with **Joi** in newer handlers and manual checks elsewhere; sanitize regex input with `utils/safeRegex`.
- Never leak `costPrice`, exact `stock`, `hidden`, or PII — use `toPublicObject` / `toCustomerProduct` / `toSafeObject`.
- Any state-changing admin/auth route needs `protect` (+ `requireAdmin`/`requireSeller`) and usually `requireSameOrigin`; sensitive endpoints need a limiter.
- Broadcast changes with `io.emit` / `io.to(room)` and update the matching frontend hook.
- Respect the atomic stock pattern; don't read-then-write stock.

**Frontend**
- TypeScript + `@/` path alias; TanStack Router file routes; TanStack Query for server state; hand-rolled observables for client state.
- Add new API calls to the relevant `lib/*.functions.ts` (not inline fetch), and normalize products through `normalizeProduct`.
- Keep the `CartItem` shape and cart-store pricing math in sync with `orderController` checkout math.
- Preserve the dev port (5000) and Vite proxy; port 3001 for the backend.
- Follow existing shadcn/ui + Tailwind 4 tokens and the editorial styling.

---

## 6. Where things live (quick index)

| Need to change… | Go to |
|---|---|
| Order placement / confirm / cancel | `controllers/orderController.js` |
| Product CRUD / list / search / featured | `controllers/productController.js` |
| Auth, OTP, sessions, profile | `controllers/authController.js` |
| Vouchers / loyalty | `controllers/voucherController.js`, `utils/voucherLifecycle.js` |
| AI admin jobs | `controllers/aiController.js`, `utils/groqKeyPool.js`, `utils/geminiPool.js` |
| Out-of-stock deletion + stock alerts | `utils/outOfStockManager.js` |
| Shipment queue / tracking | `controllers/shipmentController.js`, `controllers/orderTrackingController.js` |
| Email templates | `utils/email.js` |
| Storefront API wrappers | `src/lib/shop.functions.ts`, `api.ts` |
| Cart pricing/state | `src/lib/cart-store.ts` |
| Realtime UI sync | `src/hooks/*.ts`, `src/lib/socket.ts` |
| Admin API wrappers | `src/lib/admin.functions.ts` |
| Deploy/proxy | `functions/`, `.github/workflows/deploy-frontend.yml`, `wrangler.toml` |

---

## 7. Risks & gotchas discovered during review

These are observations, **not** changes made — verify before acting.

1. **Maintenance mode is ON by default** (`functions/middleware.ts`). A fresh deploy serves `/maintenance.html` for everything unless `MAINTENANCE_ENABLED=false`.
2. **Documentation drift:** `KIFAYAT_BACKEND_AUDIT.md` describes a codebase that no longer exists — it references removed modules (`hhcApiController`, `utils/pricing.js`, `csvExportController`, `config/tiers.js`, supplier/CSV flows). README also still mentions "HHC variation backfill" scripts and a 5000 backend port. Treat the code as source of truth.
3. **Stock restore inconsistency:** user-initiated cancellations restore stock, but several admin paths (status cancel, workflow cancels) do not — possible inventory leak.
4. **In-memory timers/state:** out-of-stock deletion, pre-order auto-cancel, AI job state, and voucher sweeper are process-local; multi-instance or restart behavior needs care (some are re-armed on boot).
5. **Stale code comment** in `src/lib/api.ts` ("proxied to localhost:5000") — backend dev is 3001.
6. **Dead/leftover scratch files at repo root** (`.tmp-*.cjs`) — one-off codemod scripts; safe to remove but confirm first.
7. **`getProductBySlug` in `shop.functions.ts`** does a fuzzy search fallback rather than a real slug lookup — the product page uses `getProductById` (which resolves slug on the backend), so prefer that path.
8. **Credentials in repo:** README warns the live `.env` and `firebase-service-account.json` were committed historically — rotate/verify before any public fork.

---

## 8. Suggested next-step verifications (not yet run)

- `kifayat-backend`: `node -e "require('./server.js')"` is not safe without env; instead run `npm run dev` with a local `.env` and hit `/api/health`.
- `kifayat-frontend`: `npm run lint`, `npm run test`, `npx tsc --noEmit`, then `npm run dev` and open `http://localhost:5000`.
- Confirm the backend listener port matches the Vite proxy target before debugging API 502s.

---

*End of analysis.*
