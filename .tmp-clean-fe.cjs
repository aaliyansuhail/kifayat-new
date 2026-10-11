const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "kifayat-frontend");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, s) => fs.writeFileSync(path.join(root, p), s);
const fails = [];
const fix = (p, pairs) => {
  let s = read(p);
  for (const [a, b] of pairs) {
    if (!s.includes(a)) { fails.push(`${p} :: ${a.slice(0, 45)}`); continue; }
    s = s.split(a).join(b);
  }
  write(p, s);
};

// 1. index.html — drop the supplier CDN preconnect hints
fix("index.html", [
  [`  <link rel="dns-prefetch" href="https://hhcnewapp.blr1.cdn.digitaloceanspaces.com" />\n`, ""],
  [`  <link rel="preconnect" href="https://hhcnewapp.blr1.cdn.digitaloceanspaces.com" crossorigin />\n`, ""],
]);

// 2. CSP — media now comes from our own origin
fix("public/_headers", [
  [`img-src 'self' data: blob: https://hhcnewapp.blr1.cdn.digitaloceanspaces.com;`, `img-src 'self' data: blob:;`],
  [`media-src 'self' blob: https://hhcnewapp.blr1.cdn.digitaloceanspaces.com;`, `media-src 'self' blob:;`],
]);

// 3. realtime sync — no more import/sync events to narrate
fix("src/hooks/use-realtime-sync.ts", [
  [`    // products_updated: emitted once after HHC import (quick fetch) or after a\n    // full HHC sync completes, plus bulk edits, out-of-stock cleanup, and\n    // recategorize completion. During syncAll the backend only emits this at\n    // the very end — every surface refreshes together in one clean swap.`,
   `    // products_updated: emitted after an admin creates/edits a product, a bulk\n    // action, or an out-of-stock cleanup. Every surface refreshes together.`],
  [`      const src = data?.source;\n      if (src === "hhc-sync" && data?.aborted) {\n        toast.warning(\n          \`Sync stopped — catalogue partially updated (\${data.totalCreated ?? 0} new, \${data.totalUpdated ?? 0} updated).\`,\n        );\n      } else if (src === "hhc-sync") {\n        toast.success(\n          \`Catalogue synced — \${data.totalCreated ?? 0} new, \${data.totalUpdated ?? 0} updated, \${(data.deletedCount ?? 0) + (data.outOfStockDeleted ?? 0)} removed.\`,\n        );\n      } else if (src === "hhc-import") {\n        toast.info(\`Catalogue updated — \${data.created ?? 0} new, \${data.updated ?? 0} updated.\`);\n      } else if (src === "recategorize") {`,
   `      const src = data?.source;\n      if (src === "recategorize") {`],
]);

// 4. order-status page copy
fix("src/routes/_authenticated/admin.order-status.tsx", [
  [`            CSV — update the status and the customer sees it instantly on{" "}`,
   `            shipment queue — update the status and the customer sees it instantly on{" "}`],
  [`            <span className="font-semibold text-foreground">"Download Main Order CSV"</span> on the`,
   `            <span className="font-semibold text-foreground">"Shipment Details"</span> section of the`],
  [`            the CSV queue. Clicking <strong className="text-foreground">"Download Main Order CSV"</strong> on the`,
   `            the shipment queue. Use the <strong className="text-foreground">"Shipment Details"</strong> page for the`],
]);

// 5. orders page leftover invalidation
fix("src/routes/_authenticated/admin.orders.tsx", [
  [`      qc.invalidateQueries({ queryKey: ["admin", "csv-queue-count"] });\n`, ""],
]);

// 6. comment touch-ups
fix("src/routes/products.$productId.tsx", [
  [`{/* Variations — from the fetched dynamic data (HHC) */}`, `{/* Variations — admin/seller defined options */}`],
]);
fix("src/lib/api.ts", [
  [`  // Filled by the "Get Product Dynamic Data" admin action (HHC dynamic API)`,
   `  // Ordered media uploaded by the admin (images first, then the video)`],
]);
fix("src/lib/shop.functions.ts", [
  [`  /** True — every seller-authored product, excluding the HHC catalogue. */`,
   `  /** True — every seller-authored product, excluding the store's own catalogue. */`],
  [`// Sourced from the main order CSV: confirmed orders awaiting export plus the`,
   `// Sourced from the shipment queue: confirmed orders awaiting dispatch plus the`],
]);
fix("src/routes/sellers.tsx", [
  [` * navbar store button, which every visitor sees — signed in or not. HHC`,
   ` * navbar store button, which every visitor sees — signed in or not. Supplier-`],
]);
fix("src/components/landing/Header.tsx", [
  [`  // products only, never the HHC catalogue.`, `  // products only, never the store's own catalogue.`],
]);
fix("src/components/admin/CourierCityField.tsx", [
  [`        Written on every CSV row as the courier city · Provider: Trax`,
   `        Saved on every shipment as the courier city · Provider: Trax`],
]);
fix("src/lib/admin.functions.ts", [
  [`// the main order CSV — so pending confirmations / pre-orders never appear.`,
   `// the shipment queue — so pending confirmations / pre-orders never appear.`],
]);

console.log(fails.length ? "FAILS:\n" + fails.join("\n") : "all cleanups applied");
