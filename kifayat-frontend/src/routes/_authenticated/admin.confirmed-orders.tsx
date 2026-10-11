import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BadgeCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MapPin,
  PackageCheck,
  Phone,
  Search,
  User,
} from "lucide-react";
import { adminListConfirmedOrders } from "@/lib/admin.functions";
import { PanelTableSkeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/admin/confirmed-orders")({
  component: AdminConfirmedOrders,
});

const rupee = (n: number) => `Rs ${Number(n || 0).toLocaleString("en-PK")}`;

const fmtDate = (v?: string) =>
  v
    ? new Date(v).toLocaleString("en-PK", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function AdminConfirmedOrders() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "order-queue", "confirmed", search, page],
    queryFn: () => adminListConfirmedOrders({ search, page, limit: 50 }),
  });

  const orders: any[] = data?.orders ?? [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const pointsTotal = orders.reduce((n, o) => n + Number(o.pointsAwarded || 0), 0);

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="text-sm font-medium tracking-wide text-muted-foreground">Orders</p>
        <h1 className="mt-1 font-display text-3xl font-bold italic tracking-tight text-foreground lg:text-4xl">
          Confirmed Orders<span className="text-brass">.</span>
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Every order you have confirmed, with the customer it belongs to, the shipment it ships
          with and the products they bought. An order lands here the moment it is confirmed — it is
          removed from Unconfirmed Orders in the same step.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Confirmed orders", value: String(total) },
          { label: "Value (this page)", value: rupee(orders.reduce((n, o) => n + Number(o.totalAmount || 0), 0)) },
          { label: "Points credited (this page)", value: pointsTotal.toLocaleString() },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl border border-border bg-card p-5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {card.label}
            </p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-foreground">{card.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-secondary/50 px-4 py-2 text-xs font-semibold text-foreground">
          Confirmed ({total})
        </span>
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, phone, email, order id, city…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-xl border border-border bg-secondary/50 py-2.5 pl-10 pr-4 text-sm transition focus:border-brass focus:outline-none"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-e1">
        {isLoading ? (
          <PanelTableSkeleton rows={6} />
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-14 text-center">
            <PackageCheck className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No confirmed orders yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Confirm an order from Unconfirmed Orders and it will appear here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {orders.map((o) => {
              const open = expandedId === o._id;
              return (
                <li key={o._id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? null : o._id)}
                    className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-secondary/40"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600">
                      <PackageCheck size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {o.user?.name || o.customer?.name || "—"}
                          {o.legacyUnattributed && (
                            <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border border-border rounded-full px-2 py-0.5">
                              Legacy
                            </span>
                          )}
                        </span>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          {o.orderNumber}
                        </span>
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600">
                          {o.status}
                        </span>
                        {Number(o.pointsAwarded) > 0 && (
                          <span className="rounded-full bg-brass/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brass">
                            +{Number(o.pointsAwarded).toLocaleString()} pts
                          </span>
                        )}
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {o.user?.email || o.customer?.email || "—"} · {o.shipment?.courierCity || "—"} ·{" "}
                        {o.itemCount} item(s) · confirmed {fmtDate(o.confirmedAt || o.createdAt)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-bold text-foreground">
                        {rupee(o.totalAmount)}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {o.shipment?.shipping}
                      </span>
                    </span>
                    <ChevronDown
                      size={16}
                      className={`shrink-0 text-muted-foreground transition ${open ? "rotate-180" : ""}`}
                    />
                  </button>

                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden bg-secondary/20"
                      >
                        <div className="grid gap-6 px-5 py-5 lg:grid-cols-3">
                          <div className="space-y-2 text-xs">
                            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                              Customer account
                            </p>
                            <p className="flex items-start gap-2 text-foreground">
                              <User size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                              <span>
                                {o.user?.name || "—"}
                                {o.user?.email ? ` · ${o.user.email}` : ""}
                              </span>
                            </p>
                            <p className="flex items-start gap-2 text-foreground">
                              <Phone size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                              <span>
                                {o.customer?.phoneNumber || "—"}
                                {o.customer?.phoneNumber2 ? ` / ${o.customer.phoneNumber2}` : ""}
                              </span>
                            </p>
                            <p className="break-all text-muted-foreground">
                              User ID:{" "}
                              <span className="font-mono text-[11px] text-foreground">
                                {o.user?._id || "—"}
                              </span>
                            </p>
                            <p className="text-muted-foreground">
                              Loyalty points balance:{" "}
                              <span className="font-semibold text-foreground">
                                {Number(o.user?.loyaltyPoints ?? 0).toLocaleString()}
                              </span>
                            </p>
                            <p className="inline-flex items-center gap-1.5 font-semibold text-emerald-600">
                              <BadgeCheck size={13} />
                              {Number(o.pointsAwarded || 0).toLocaleString()} points credited for this
                              order
                            </p>
                          </div>

                          <div className="space-y-2 text-xs">
                            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                              Shipment details
                            </p>
                            <p className="flex items-start gap-2 text-foreground">
                              <MapPin size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                              <span>
                                {o.shipment?.address || "—"}
                                {o.shipment?.courierCity ? `, ${o.shipment.courierCity}` : ""}
                              </span>
                            </p>
                            <p className="text-muted-foreground">
                              {o.shipment?.shpType} · {o.shipment?.courierCompany} · open parcel:{" "}
                              {o.shipment?.allowToOpen || "no"}
                            </p>
                            <p className="text-muted-foreground capitalize">
                              Payment: {o.shipment?.shipping || "cod"} · collect{" "}
                              <span className="font-semibold text-foreground">
                                {rupee(o.totalAmount)}
                              </span>
                            </p>
                            {o.shipment?.courierInstruction && (
                              <p className="text-muted-foreground">
                                Courier note: {o.shipment.courierInstruction}
                              </p>
                            )}
                            <p className="text-muted-foreground">
                              Confirmed at: {fmtDate(o.confirmedAt)}
                            </p>
                          </div>

                          <div className="space-y-2">
                            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                              What they ordered
                            </p>
                            <ul className="space-y-1.5">
                              {o.items.map((item: any, i: number) => (
                                <li
                                  key={`${item.productId}-${i}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2 text-xs"
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate font-medium text-foreground">
                                      {item.name || item.productId || "Item"}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {item.productId}
                                      {item.variation ? ` · ${item.variation}` : ""}
                                    </span>
                                  </span>
                                  <span className="shrink-0 text-right">
                                    <span className="block font-semibold text-foreground">
                                      {rupee(item.price)}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground">
                                      × {item.quantity}
                                    </span>
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {data?.page ?? page} of {pages} · {total} order(s)
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="grid size-9 place-items-center rounded-lg border border-border transition hover:border-brass disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="grid size-9 place-items-center rounded-lg border border-border transition hover:border-brass disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
