import { useQuery } from "@tanstack/react-query";
import { Search, Package } from "lucide-react";
import { useState } from "react";
import { listProducts } from "@/lib/shop.functions";
import { optImage } from "@/lib/product-image-map";
import type { UIProduct } from "@/lib/api";

/**
 * Type-ahead product picker. Used by the report-defective forms to optionally
 * attach the product a report is about.
 */
export function ProductSearch({ onSelect }: { onSelect: (p: UIProduct) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const { data: results = [], isLoading } = useQuery({
    queryKey: ["product-search", query],
    queryFn: () => listProducts({ search: query, limit: 8 }).then((r) => r.products),
    enabled: query.length >= 2,
  });

  return (
    <div className="relative">
      <label className="block text-sm font-medium mb-1.5">Search Product</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Type product name..."
          className="w-full h-11 pl-9 pr-3.5 rounded-md border border-border outline-none focus:border-primary text-sm"
        />
      </div>
      {open && query.length >= 2 && (isLoading || results.length > 0) && (
        <ul className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg shadow-lg max-h-56 overflow-y-auto">
          {isLoading
            ? Array.from({ length: 3 }).map((_, i) => (
                <li key={i} className="px-3.5 py-2.5 flex items-center gap-3">
                  <div className="size-8 rounded bg-secondary animate-pulse shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 rounded bg-secondary animate-pulse w-3/4" />
                    <div className="h-2.5 rounded bg-secondary animate-pulse w-1/3" />
                  </div>
                </li>
              ))
            : results.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => { onSelect(p); setQuery(""); setOpen(false); }}
                    className="w-full text-left px-3.5 py-2.5 text-sm hover:bg-secondary flex items-center gap-3"
                  >
                    {p.image_url ? (
                      <img src={optImage(p.image_url, 80)} alt="" className="size-8 rounded object-cover shrink-0" />
                    ) : (
                      <Package className="size-8 rounded object-cover shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.name}</p>
                      <p className="text-xs text-muted-foreground">Rs. {p.price?.toLocaleString()}</p>
                    </div>
                  </button>
                </li>
              ))}
        </ul>
      )}
      {open && query.length >= 2 && results.length === 0 && (
        <div className="absolute z-20 mt-1 w-full bg-card border border-border rounded-lg shadow-lg p-3 text-sm text-muted-foreground">
          No products found
        </div>
      )}
      {open && query.length >= 2 && (
        <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
      )}
    </div>
  );
}
