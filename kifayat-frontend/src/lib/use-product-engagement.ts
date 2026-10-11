import { useCallback, useEffect, useRef } from "react";
import { trackInteraction, type InteractionType } from "./product-tracking";

type TrackableProduct = {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
  sellerId?: string | null;
  price?: number | null;
};

/**
 * Wire engagement signals for a single product card.
 *
 * - `view` fires once the card has been at least 50% visible for a second, so
 *   impression counts are not inflated by fast scrolling.
 * - `hover` fires on pointer enter, deduped per product per 30 min.
 * - `click` fires on pointer down so it survives navigation.
 *
 * Returns spread-ready handlers plus a ref for the tracked element.
 */
export function useProductEngagement(product: TrackableProduct) {
  const { id, slug, name, sellerId, price } = product;
  const trackable = Boolean(id && sellerId);
  const ref = useRef<HTMLElement | null>(null);

  const meta = useCallback(
    () => ({ slug: slug ?? undefined, name: name ?? undefined, price: price ?? undefined }),
    [slug, name, price],
  );

  const send = useCallback(
    (type: InteractionType) => {
      if (!trackable || !id) return;
      trackInteraction(id, type, meta());
    },
    [trackable, id, meta],
  );

  // Impression tracking — only for cards that are actually rendered.
  useEffect(() => {
    const node = ref.current;
    if (!trackable || !id || !node || typeof IntersectionObserver === "undefined") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
            if (!timer) timer = setTimeout(() => send("view"), 1000);
          } else if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
        }
      },
      { threshold: [0, 0.5, 1] },
    );

    observer.observe(node);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [trackable, id, send]);

  const onPointerEnter = useCallback(() => send("hover"), [send]);
  const onPointerDown = useCallback(() => send("click"), [send]);
  // Keyboard users get counted too.
  const onFocus = useCallback(() => send("hover"), [send]);
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") send("click");
    },
    [send],
  );

  return { ref, trackable, engagementProps: { onPointerEnter, onFocus, onKeyDown, onPointerDown } };
}
