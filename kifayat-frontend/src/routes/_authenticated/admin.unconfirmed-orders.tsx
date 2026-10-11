import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BadgeCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Loader2,
  MapPin,
  MessageCircle,
  Phone,
  Search,
  User,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { adminConfirmOrder, adminListUnconfirmedOrders } from "@/lib/admin.functions";
import { PanelTableSkeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/admin/unconfirmed-orders")({
  component: AdminUnconfirmedOrders,
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

/** Same WhatsApp deep-link shape the shipment page uses. */
function waNumber(raw?: string) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("92")) return digits;
  if (digits.startsWith("0")) return `92${digits.slice(1)}`;
  return digits;
}

function waLink(order: any) {
  const number = waNumber(order?.shipment?.phoneNumber);
  if (!number) return "";
  const lines = (order.items || [])
    .map((i: any) => `• ${i.name || i.productId} × ${i.quantity}`)
    .join("\n");
  const text =
    `Assalam-o-Alaikum ${order.customer?.name || ""}!\n\n` +
    `This is Kifayat confirming your order ${order.orderNumber}.\n\n` +
    (lines ? `${lines}\n\n` : "") +
    `Total (cash on delivery): ${rupee(order.totalAmount)}\n` +
    (order.shipment?.courierCity
      ? `Delivering to: ${order.shipment.address}, ${order.shipment.courierCity}\n`
      : "") +
    `\nPlease reply YES to confirm.`;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function AdminUnconfirmedOrders() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "order-queue", "unconfirmed", search, page],
    queryFn: () => adminListUnconfirmedOrders({ search, page, limit: 50 }),
  });

  const confirmMut = useMutation({
    mutationFn: (preOrderId: string) => adminConfirmOrder(preOrderId),
    onSuccess: (res: any) => {
      setPendingConfirm(null);
      if (res?.success === false) {
        toast.error(res?.message ?? "Could not confirm the order.");
      } else {
        toast.success(
          res?.pointsAwarded > 0
            ? `${res?.message ?? "Order confirmed."} ${res.pointsAwarded} loyalty points credited.`
            : (res?.message ?? "Order confirmed."),
        );
      }
      qc.invalidateQueries({ queryKey: ["admin", "order-queue"] });
      qc.invalidateQueries({ queryKey: ["admin", "shipments"] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "order-status"] });
    },
    onError: (e: any) => {
      setPendingConfirm(null);
      toast.error(e?.message ?? "Could not confirm the order.");
    },
  });

  const orders: any[] = data?.orders ?? [];
  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="text-sm font-medium tracking-wide text-muted-foreground">Orders</p>
        <h1 className="mt-1 font-display text-3xl font-bold italic tracking-tight text-foreground lg:text-4xl">
          Unconfirmed Orders<span className="text-brass">.</span>
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Orders customers have placed that are still waiting for your confirmation — with the
          complete account, shipment form and product detail. Confirming moves the order (and all of
          its data) into Confirmed Orders and credits the customer's loyalty points.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-secondary/50 px-4 py-2 text-xs font-semibold text-foreground">
          Awaiting confirmation ({total})
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
            <Inbox className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No unconfirmed orders</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              New orders land here the moment a customer checks out.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {orders.map((o) => {
              const open = expandedId === o._id;
              const wa = waLink(o);
              const confirming = confirmMut.isPending && pendingConfirm === o._id;
              return (
                <li key={o._id}>
                  <button
                    type="button"
                    onClick={() => setExpandedId(open ? null : o._id)}
                    className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-secondary/40"
                  >
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-500/10 text-amber-600">
                      <Inbox size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {o.customer?.name || o.user?.name || "—"}
                        </span>
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          {o.orderNumber}
                        </span>
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-600">
                          {o.status}
                        </span>
                      </span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">
                        {o.user?.email || o.customer?.email || "—"} · {o.shipment?.courierCity || "—"} ·{" "}
                        {o.itemCount} item(s) · {fmtDate(o.createdAt)}
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
                          {/* Customer / account */}
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
                              Loyalty points:{" "}
                              <span className="font-semibold text-foreground">
                                {Number(o.user?.loyaltyPoints ?? 0).toLocaleString()}
                              </span>
                            </p>
                          </div>

                          {/* Shipment */}
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
                              Confirmation expires: {fmtDate(o.confirmationExpiresAt)}
                            </p>
                          </div>

                          {/* Products */}
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

                          <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground">
                            <BadgeCheck size={14} className="text-brass" />
                            {Number(o.pointsPreview ?? 0).toLocaleString()} loyalty points on confirm
                          </span>

                          {pendingConfirm === o._id ? (
                            <span className="ml-auto flex items-center gap-2">
                              <span className="text-xs font-semibold text-foreground">
                                Move this order to Confirmed Orders?
                              </span>
                              <button
                                type="button"
                                onClick={() => confirmMut.mutate(o._id)}
                                disabled={confirming}
                                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                              >
                                {confirming ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <BadgeCheck size={14} />
                                )}
                                {confirming ? "Confirming…" : "Yes, confirm"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingConfirm(null)}
                                disabled={confirming}
                                className="inline-flex items-center gap-1 rounded-xl border border-border px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:text-foreground disabled:opacity-50"
                              >
                                <X size={14} /> Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPendingConfirm(o._id)}
                              className="ml-auto inline-flex items-center gap-2 rounded-xl bg-foreground px-4 py-2 text-xs font-bold text-background transition hover:opacity-90"
                            >
                              <BadgeCheck size={14} /> Confirm order
                            </button>
                          )}
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
