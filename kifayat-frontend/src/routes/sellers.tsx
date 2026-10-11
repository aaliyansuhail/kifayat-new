import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ShoppingBag, Package } from "lucide-react";
import { PageShell, PageHeader } from "@/components/landing/PageShell";
import { ProductCard } from "@/components/shop/ProductCard";
import { ProductGridSkeleton } from "@/components/ui/skeleton";
import { listProducts } from "@/lib/shop.functions";
import { SELLER_STORE_NAME, SELLER_STORE_TITLE } from "@/lib/seller-store";

export const Route = createFileRoute("/sellers")({
  component: SellerProducts,
});

/**
 * Public storefront of products the seller listed themselves. Reached from the
 * navbar store button, which every visitor sees — signed in or not. Supplier-
 * imported products are excluded server-side by ?sellers_only=true.
 */

function SellerProducts() {
  const { data, isLoading } = useQuery({
    queryKey: ["sellers-only-products"],
    queryFn: () => listProducts({ sellersOnly: true, limit: 100 }),
    staleTime: 60_000,
  });

  const products = data?.products ?? [];

  return (
    <PageShell>
      <PageHeader
        title={SELLER_STORE_NAME}
        subtitle={`${SELLER_STORE_TITLE} listed directly by the seller.`}
        breadcrumbs={[{ label: "Home", to: "/" }, { label: SELLER_STORE_NAME }]}
      />

      <section className="max-w-[1400px] mx-auto px-4 lg:px-8 py-8 lg:py-10">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-14 h-14 bg-brass rounded-full flex items-center justify-center shrink-0">
            <ShoppingBag className="w-7 h-7 text-coal" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-2xl">{SELLER_STORE_TITLE}</h2>
            <p className="text-xs text-coal/50">
              {isLoading
                ? "Loading…"
                : `${products.length} product${products.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        {isLoading ? (
          <ProductGridSkeleton
            count={8}
            columns="grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-5 lg:gap-6"
          />
        ) : products.length === 0 ? (
          <div className="text-center py-24 border border-dashed border-coal/10">
            <Package className="size-16 text-coal/30 mx-auto mb-4" />
            <p className="font-display italic text-3xl text-coal/30 mb-2">No products yet.</p>
            <p className="text-sm text-coal/55">
              Faiza hasn't listed anything on her store yet.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-5 lg:gap-6">
            {products.map((p, i) => (
              <ProductCard
                key={p.id}
                index={i}
                p={{
                  id: p.id,
                  slug: p.slug,
                  name: p.name,
                  brand: p.brand,
                  price: p.price,
                  oldPrice: p.old_price,
                  image: p.image_url || "",
                  badge: p.badge,
                  inStock: p.inStock,
                  sellerId: p.sellerId,
                }}
              />
            ))}
          </div>
        )}
      </section>
    </PageShell>
  );
}