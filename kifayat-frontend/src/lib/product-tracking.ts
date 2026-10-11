/**
 * Storefront product engagement tracking.
 *
 * Records three signals per seller-owned product so the seller dashboard can
 * answer "how many customers actually looked at / hovered over / clicked this":
 *   - view  : the card was on screen for a moment (impression)
 *   - hover : the pointer entered the card
 *   - click : the card opened the product page
 *
 * Everything is fire-and-forget: sendBeacon keeps the request alive while the
 * page navigates, and failures are swallowed so tracking can never break a
 * shopper's session.
 */

export type InteractionType = "view" | "hover" | "click" | "pageview";

const VISITOR_KEY = "kf_visitor_id";
const DEDUPE_KEY = "kf_tracked_interactions";

/** Same product + scope + type is only counted once per this many ms. */
const DEDUPE_TTL = {
  view: 30 * 60 * 1000,
  hover: 30 * 60 * 1000,
  pageview: 30 * 60 * 1000,
  click: 2 * 1000,
};

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let cachedVisitorId: string | null = null;

/** Stable per-browser id — the unit "unique customer" is counted in. */
export function getVisitorId(): string {
  if (cachedVisitorId) return cachedVisitorId;
  if (typeof window === "undefined") return "ssr";

  try {
    const stored = window.localStorage.getItem(VISITOR_KEY);
    if (stored) {
      cachedVisitorId = stored;
      return stored;
    }
    const id = randomId();
    window.localStorage.setItem(VISITOR_KEY, id);
    cachedVisitorId = id;
    return id;
  } catch {
    // Private mode / storage disabled — fall back to an in-memory id.
    cachedVisitorId = randomId();
    return cachedVisitorId;
  }
}

function shouldSend(
  productId: string,
  type: InteractionType,
  scope: string,
  now: number,
): boolean {
  if (typeof window === "undefined") return false;
  const ttl = DEDUPE_TTL[type];
  try {
    const raw = window.localStorage.getItem(DEDUPE_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    const key = `${type}:${scope}:${productId}`;
    const last = map[key] ?? 0;
    if (now - last < ttl) return false;
    map[key] = now;
    // Opportunistic prune so the map cannot grow without bound.
    const cutoff = now - 60 * 60 * 1000;
    for (const [k, v] of Object.entries(map)) {
      if (v < cutoff) delete map[k];
    }
    window.localStorage.setItem(DEDUPE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return true;
  }
}

export function trackInteraction(
  productId: string | null | undefined,
  type: InteractionType,
  metadata: Record<string, unknown> = {},
): void {
  if (!productId) return;
  if (typeof window === "undefined") return;

  // Cards on different pages are different scopes — someone browsing the same
  // product from the grid and from a seller store counts as two impressions.
  const scope =
    typeof metadata.scope === "string" && metadata.scope
      ? metadata.scope
      : window.location.pathname;

  const now = Date.now();
  if (!shouldSend(productId, type, scope, now)) return;

  const payload = JSON.stringify({
    productId,
    type,
    sessionId: getVisitorId(),
    metadata: { ...metadata, scope, path: window.location.pathname, ts: now },
  });

  try {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon?.("/api/interactions/track", blob)) return;
  } catch {
    // Fall through to fetch.
  }

  void fetch("/api/interactions/track", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => undefined);
}

/** True when this product belongs to a seller and is therefore trackable. */
export function isTrackableProduct(product: {
  id?: string | null;
  sellerId?: string | null;
}): boolean {
  return Boolean(product.id && product.sellerId);
}
