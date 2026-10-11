import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  MessageCircle,
  Phone,
  Search,
  Truck,
  User,
} from "lucide-react";
import { toast } from "sonner";
import {
  adminConfirmOrder,
  adminGetShipments,
  adminGetShipmentStats,
} from "@/lib/admin.functions";
import { PanelTableSkeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/admin/shipments")({
  component: AdminShipments,
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

/**
 * Turn whatever the customer typed into a wa.me-ready international number.
 * Local Pakistani numbers start with 0 — WhatsApp needs the 92 country code.
 */
function waNumber(raw?: string) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("92")) return digits;
  if (digits.startsWith("0")) return `92${digits.slice(1)}`;
  return digits;
}

function waLink(order: any) {
  const number = waNumber(order.phoneNumber);
  if (!number) return "";
  const lines = (order.items || [])
    .map((i: any) => `• ${i.name || i.productId} × ${i.quantity}`)
    .join("\n");
  const text =
    `Assalam-o-Alaikum ${order.customerName || ""}!\n\n` +
    `This is Kifayat confirming your order ${order.orderNumber}.\n\n` +
    (lines ? `${lines}\n\n` : "") +
    `Total (cash on delivery): ${rupee(order.sellPrice)}\n` +
    (order.courierCity ? `Delivering to: ${order.address}, ${order.courierCity}\n` : "") +
    `\nPlease reply YES to confirm.`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function AdminShipments() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const qc = useQueryClient();

  const confirmedQuery = useQuery({
    queryKey: ["admin", "shipments", "confirmed", search, page],
    queryFn: () => adminGetShipments({ search, page, limit: 50 }),
  });
  const { data: stats } = useQuery({
    queryKey: ["admin", "shipments", "stats"],
    queryFn: adminGetShipmentStats,
  });

  const confirmMut = useMutation({
    mutationFn: (orderId: string) => adminConfirmOrder(orderId),
    onSuccess: (res: any) => {
      if (res?.success === false) {
        toast.error(res?.message ?? "Could not confirm the order.");
        return;
      }
      toast.success(
        res?.pointsAwarded > 0
          ? `${res?.message ?? "Order confirmed."} ${res.pointsAwarded} loyalty points credited.`
          : (res?.message ?? "Order confirmed."),
      );
      qc.invalidateQueries({ queryKey: ["admin", "shipments"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not confirm the order."),
  });

  const active = confirmedQuery;
  const shipments: any[] = active.data?.shipments ?? [];
  const total = active.data?.total ?? 0;
  const pages = active.data?.pages ?? 1;

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="text-sm font-medium text-muted-foreground tracking-wide">Orders</p>
        <h1 className="font-display italic text-3xl lg:text-4xl mt-1 font-bold tracking-tight text-foreground">
          Shipment Details<span className="text-brass">.</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          Every order with its full delivery record — who ordered what, where it goes and how much
          cash to collect. Confirm straight from here after you message the customer on WhatsApp.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Total shipments", value: String(stats?.total ?? confirmedQuery.data?.total ?? 0) },
          { label: "COD value", value: rupee(stats?.codTotal ?? 0) },
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
          Confirmed ({confirmedQuery.data?.total ?? 0})
        </span>

        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by name, phone, order id, city…"
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
        {active.isLoading ? (
          <PanelTableSkeleton rows={6} />
        ) : shipments.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-14 text-center">
            <Truck className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              No confirmed shipments yet
            </p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Orders appear here the moment they are confirmed.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {shipments.map((s) => {
              const open = expandedId === s._id;
              const wa = waLink(s);
              return (
                <li key={s._id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? null : s._id)}
                    className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-secondary/40"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary/60 text-foreground">
                      <Truck size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {s.customerName || "—"}
                          {s.legacyUnattributed && (
                            <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border border-border rounded-full px-2 py-0.5">
                              Legacy
                            </span>
                          )}
                        </span>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          {s.orderNumber}
                        </span>
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600">
                          {s.status}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {s.courierCity || "—"} · {s.courierCompany || "—"} · {s.productCount} item(s)
                        · {fmtDate(s.createdAt)}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-bold text-foreground">
                        {rupee(s.sellPrice)}
                      </span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        {s.shipping}
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
                        <div className="grid gap-6 px-5 py-5 lg:grid-cols-2">
                          <div className="space-y-2 text-xs">
                            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                              Delivery details
                            </p>
                            <p className="flex items-start gap-2 text-foreground">
                              <User size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                              <span>
                                {s.customerName || "—"}
                          {s.legacyUnattributed && (
                            <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border border-border rounded-full px-2 py-0.5">
                              Legacy
                            </span>
                          )}
                                {s.email ? ` · ${s.email}` : ""}
                              </span>
                            </p>
                            <p className="flex items-start gap-2 text-foreground">
                              <Phone size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                              <span>
                                {s.phoneNumber || "—"}
                                {s.phoneNumber2 ? ` / ${s.phoneNumber2}` : ""}
                              </span>
                            </p>
                            <p className="flex items-start gap-2 text-foreground">
                              <MapPin size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                              <span>
                                {s.address || "—"}
                                {s.courierCity ? `, ${s.courierCity}` : ""}
                              </span>
                            </p>
                            <p className="text-muted-foreground">
                              {s.shpType} · {s.courierCompany} · open parcel:{" "}
                              {s.allowToOpen || "no"}
                            </p>
                            {s.courierInstruction && (
                              <p className="text-muted-foreground">
                                Courier note: {s.courierInstruction}
                              </p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                              What they ordered
                            </p>
                            <ul className="space-y-1.5">
                              {s.items.map((item: any, i: number) => (
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

                        <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-4">
                          {wa ? (
                            <a
                              href={wa}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-xs font-bold text-emerald-600 transition hover:bg-emerald-500/10"
                            >
                              <MessageCircle size={14} /> Message on WhatsApp
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              No phone number on record to message.
                            </span>
                          )}

                          <span className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-600">
                            <CheckCircle2 size={14} /> Confirmed
                          </span>
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
            Page {active.data?.page ?? page} of {pages} · {total} order(s)
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
