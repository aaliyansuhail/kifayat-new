import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  Activity, ArrowUpRight, Eye, Hand, MousePointerClick, Users, RefreshCw, LayoutGrid,
} from "lucide-react";
import { toast } from "sonner";
import {
  fetchInteractionAnalytics,
  type InteractionAnalytics,
} from "@/lib/seller-analytics.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@tanstack/react-router";

const RANGES = [7, 30, 90] as const;

const TYPE_LABEL: Record<string, string> = {
  view: "Card impression",
  hover: "Hover",
  click: "Click",
  pageview: "Product page view",
};

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function Delta({ now, prev }: { now: number; prev: number }) {
  if (!prev) return null;
  const change = ((now - prev) / prev) * 100;
  const up = change >= 0;
  return (
    <span className={`text-[11px] font-semibold ${up ? "text-emerald-600" : "text-red-500"}`}>
      {up ? "+" : ""}
      {change.toFixed(0)}%
    </span>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  delta,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
  delta?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        <div className="mt-1 flex items-center gap-2">
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
          {delta}
        </div>
      </CardContent>
    </Card>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}

export function EngagementAnalytics() {
  const [days, setDays] = useState<number>(30);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["seller-interactions", days],
    queryFn: () => fetchInteractionAnalytics(days),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (error) toast.error(error.message || "Failed to load engagement analytics");
  }, [error]);

  const totals = data?.totals;
  const previous = data?.previousTotals;

  const chartData = useMemo(
    () =>
      (data?.timeline ?? []).map((d) => ({
        date: d.date.slice(5), // MM-DD
        Views: d.views,
        Hovers: d.hovers,
        Clicks: d.clicks,
        "Page views": d.pageviews,
      })),
    [data?.timeline],
  );

  const topProducts = useMemo(() => (data?.products ?? []).slice(0, 10), [data?.products]);

  return (
    <div className="space-y-6">
      {/* Header + range switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-coal">Customer Engagement</h2>
          <p className="text-sm text-coal/60">
            Real-time clicks, hovers and impressions on your products
          </p>
        </div>
        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              aria-pressed={days === r}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition ${
                days === r
                  ? "border-coal bg-coal text-bone"
                  : "border-coal/15 text-coal/60 hover:border-coal/40 hover:text-coal"
              }`}
            >
              {r}d
            </button>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Headline numbers */}
      {isLoading || !totals ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6 space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Stat
            icon={Users}
            label="Unique Customers"
            value={totals.uniqueVisitors.toLocaleString()}
            hint={`last ${days} days`}
          />
          <Stat
            icon={MousePointerClick}
            label="Total Clicks"
            value={totals.clicks.toLocaleString()}
            hint={`${totals.clicksPerVisitor} per customer`}
            delta={<Delta now={totals.clicks} prev={previous?.clicks ?? 0} />}
          />
          <Stat
            icon={Hand}
            label="Total Hovers"
            value={totals.hovers.toLocaleString()}
            hint={`${totals.hoversPerVisitor} per customer`}
            delta={<Delta now={totals.hovers} prev={previous?.hovers ?? 0} />}
          />
          <Stat
            icon={Activity}
            label="Click-through rate"
            value={pct(totals.clickThroughRate)}
            hint={`${totals.clicks} of ${totals.views} impressions`}
            delta={<Delta now={totals.clicks} prev={previous?.clicks ?? 0} />}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trend */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Engagement over time</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <PanelSkeleton />
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gViews" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#c9a14a" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#c9a14a" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gClicks" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#1a1a1a" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#1a1a1a" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a14" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: "#1a1a1a80" }}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "#1a1a1a80" }}
                      axisLine={false}
                      tickLine={false}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #1a1a1a14" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="Views"
                      stroke="#c9a14a"
                      strokeWidth={2}
                      fill="url(#gViews)"
                    />
                    <Area
                      type="monotone"
                      dataKey="Clicks"
                      stroke="#1a1a1a"
                      strokeWidth={2}
                      fill="url(#gClicks)"
                    />
                    <Area type="monotone" dataKey="Hovers" stroke="#6366f1" strokeWidth={1.5} fill="none" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Funnel + devices */}
        <Card>
          <CardHeader>
            <CardTitle>Funnel & devices</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!data ? (
              <PanelSkeleton />
            ) : (
              <>
                <div className="space-y-2">
                  {(() => {
                    const impressions = totals?.views ?? 0;
                    const funnel = [
                      { label: "Impressions", value: impressions },
                      { label: "Hovered", value: totals?.hovers ?? 0 },
                      { label: "Clicked", value: totals?.clicks ?? 0 },
                      { label: "Reached product page", value: totals?.pageviews ?? 0 },
                    ];
                    return funnel.map((step, i) => {
                      const share = impressions ? step.value / impressions : 0;
                      const perCustomer =
                        i === 0
                          ? totals?.uniqueVisitors ?? 0
                          : (funnel[i - 1].value ?? 0) > 0
                            ? step.value / funnel[i - 1].value
                            : 0;
                      return (
                        <div key={step.label}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-coal/70">{step.label}</span>
                            <span className="font-semibold tabular-nums">
                              {step.value.toLocaleString()}
                              {i > 0 && step.value > 0 ? (
                                <span className="ml-1 text-coal/40">
                                  ({pct(share)} of views)
                                </span>
                              ) : null}
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 rounded-full bg-coal/8 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-brass transition-all"
                              style={{ width: `${Math.min(100, Math.max(1, share * 100))}%` }}
                            />
                          </div>
                          {i > 0 && (
                            <p className="mt-0.5 text-[10px] text-coal/40">
                              {(perCustomer * 100).toFixed(0)}% of the step above
                            </p>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>

                <div className="pt-2 border-t border-coal/10">
                  <p className="text-xs font-medium text-coal/60 mb-2">Devices</p>
                  {data.devices.length === 0 ? (
                    <p className="text-xs text-coal/40">No device data yet.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {data.devices.map((d) => (
                        <span
                          key={d.device}
                          className="inline-flex items-center gap-1.5 rounded-full border border-coal/10 px-2.5 py-1 text-[11px]"
                        >
                          {d.device}
                          <span className="font-semibold tabular-nums">{d.count}</span>
                          <span className="text-coal/40">{pct(d.share)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {data.referrers.length > 0 && (
                  <div className="pt-2 border-t border-coal/10">
                    <p className="text-xs font-medium text-coal/60 mb-2">Top sources</p>
                    <ul className="space-y-1">
                      {data.referrers.slice(0, 5).map((r) => (
                        <li key={r.referrer} className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate text-coal/70" title={r.referrer}>
                            {r.referrer.replace(/^https?:\/\//, "").slice(0, 40)}
                          </span>
                          <span className="font-semibold tabular-nums shrink-0">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-product breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Per-product engagement</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <PanelSkeleton />
          ) : topProducts.length === 0 ? (
            <div className="text-center py-10">
              <LayoutGrid className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">
                No engagement recorded yet. Browsers on your products will show up here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Impressions</TableHead>
                    <TableHead className="text-right">Hovers</TableHead>
                    <TableHead className="text-right">Clicks</TableHead>
                    <TableHead className="text-right">Page views</TableHead>
                    <TableHead className="text-right">Visitors</TableHead>
                    <TableHead className="text-right">CTR</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topProducts.map((p) => (
                    <TableRow key={p.productId}>
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-3 min-w-0">
                          {p.image ? (
                            <img
                              src={p.image.split("?")[0]}
                              alt=""
                              loading="lazy"
                              className="size-10 shrink-0 rounded-md object-cover bg-bone"
                            />
                          ) : null}
                          <span className="truncate max-w-[220px]">{p.name}</span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.views}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.hovers}</TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">{p.clicks}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.pageviews}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.visitors}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span
                          className={`inline-flex items-center gap-1 ${
                            p.ctr >= 0.1
                              ? "text-emerald-600"
                              : p.ctr > 0
                                ? "text-coal/70"
                                : "text-coal/30"
                          }`}
                        >
                          {pct(p.ctr)}
                          <ArrowUpRight className="h-3 w-3" />
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live activity feed */}
      {!isLoading && data && data.recent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              Latest customer activity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-coal/8">
              {data.recent.slice(0, 12).map((r) => (
                <li key={r._id} className="py-2 flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 flex items-center gap-2">
                    <span className="shrink-0 rounded-full bg-coal/6 px-2 py-0.5 font-medium">
                      {TYPE_LABEL[r.type] ?? r.type}
                    </span>
                    <span className="truncate text-coal/70">{r.productName ?? "Unknown product"}</span>
                  </span>
                  <span className="shrink-0 text-coal/40">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[11px] text-coal/40">
              Browsing as a customer on another device or incognito window shows up here in
              real time.{" "}
              <Link to="/seller" className="underline">
                Refresh
              </Link>{" "}
              with the button above.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
