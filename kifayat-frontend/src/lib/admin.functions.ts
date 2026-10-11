/**
 * Admin functions backed by the Kifayat Express API.
 */
import { api, normalizeProduct } from "./api";

// ─── Dashboard ─────────────────────────────────────────────────────────────

export async function adminDashboardStats(): Promise<any> {
  const [statsRes, ordersRes] = await Promise.all([
    api.get<{ success: boolean; stats: any }>("/products/stats"),
    api.get<{ success: boolean; orders: any[] }>("/orders"),
  ]);

  const orders = ordersRes.orders ?? [];
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);

  const orders30 = orders.filter((o) => new Date(o.createdAt) >= since30d);
  const orders7 = orders.filter((o) => new Date(o.createdAt) >= since7d);
  const ordersToday = orders.filter((o) => new Date(o.createdAt) >= startOfDay);

  const sum = (arr: any[]) =>
    arr.reduce((s, o) => s + Number(o.totalAmount ?? 0), 0);

  // Revenue series — last 14 days
  const dayMap = new Map<string, { date: string; revenue: number; orders: number }>();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    dayMap.set(k, { date: k, revenue: 0, orders: 0 });
  }
  orders30.forEach((o: any) => {
    const k = o.createdAt?.slice(0, 10);
    if (k && dayMap.has(k)) {
      const e = dayMap.get(k)!;
      e.revenue += Number(o.totalAmount ?? 0);
      e.orders += 1;
    }
  });

  // Orders by status
  const statusMap = new Map<string, number>();
  orders30.forEach((o: any) => {
    statusMap.set(o.status, (statusMap.get(o.status) ?? 0) + 1);
  });
  const orders_by_status = Array.from(statusMap.entries()).map(([status, count]) => ({ status, count }));

  // Top products by salesCount
  const stats = statsRes.stats ?? {};

  return {
    kpi: {
      revenue_today: sum(ordersToday),
      revenue_7d: sum(orders7),
      revenue_30d: sum(orders30),
      orders_today: ordersToday.length,
      orders_7d: orders7.length,
      orders_30d: orders30.length,
      aov_30d: orders30.length ? sum(orders30) / orders30.length : 0,
      customers_total: stats.totalUsers ?? 0,
      products_total: stats.totalProducts ?? 0,
      reviews_pending: 0,
      questions_pending: 0,
      searches_7d: 0,
    },
    revenue_series: Array.from(dayMap.values()),
    orders_by_status,
    top_products: [],
    low_stock: [],
  };
}

// ─── Orders ────────────────────────────────────────────────────────────────

export async function adminListOrders(): Promise<any[]> {
  const data = await api.get<{ success: boolean; orders: any[]; shippingMap: Record<string, any> }>("/orders");
  const shippingMap: Record<string, any> = data.shippingMap ?? {};
  return (data.orders ?? []).map((o: any) => {
    const shipping = shippingMap[String(o._id)] ?? {};
    return {
      id: o._id,
      order_number: `KFY-${String(o._id).slice(-6).toUpperCase()}`,
      contact_name: shipping.name ?? o.user?.name ?? "",
      contact_phone: shipping.phoneNumber ?? "",
      address: shipping.address ?? "",
      city: shipping.courierCity ?? "",
      latitude: shipping.latitude ?? null,
      longitude: shipping.longitude ?? null,
      province: "",
      total: o.totalAmount,
      status: o.status,
      payment_method: shipping.shipping ?? "cod",
      created_at: o.createdAt,
      // Include raw data for expanded detail view
      _raw: {
        items: (o.items ?? []).map((item: any) => ({
          name: item.name ?? item.product?.name ?? "",
          quantity: item.quantity ?? item.qty ?? 1,
          price: item.price ?? item.product?.salePrice ?? 0,
        })),
        shippingDetail: shipping,
      },
    };
  });
}

export async function adminUpdateOrderStatus(
  id: string,
  status: string,
): Promise<{ ok: boolean }> {
  await api.patch(`/orders/${id}/status`, { status });
  return { ok: true };
}

// ─── Products ──────────────────────────────────────────────────────────────

export async function adminListProducts(): Promise<any[]> {
  const data = await api.get<{ success: boolean; products: any[] }>(
    "/products/admin-list?limit=1000",
  );
  return (data.products ?? []).map(normalizeProduct);
}

export async function adminUpsertProduct(input: any): Promise<{ ok: boolean }> {
  if (input.id) {
    await api.put(`/products/${input.id}`, input);
  }
  return { ok: true };
}

export async function adminDeleteProduct(id: string): Promise<{ ok: boolean }> {
  await api.del(`/products/${id}`);
  return { ok: true };
}

export async function adminGetDeletedProducts(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/products/deleted${qs ? `?${qs}` : ""}`);
}

export async function adminRestoreProduct(id: string): Promise<any> {
  return api.patch<any>(`/products/${id}/restore`);
}

// ─── Reviews ───────────────────────────────────────────────────────────────

export async function adminListReviews(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/reviews/admin${qs ? `?${qs}` : ""}`);
}

export async function adminDeleteReviewById(id: string): Promise<{ ok: boolean }> {
  await api.del(`/reviews/${id}`);
  return { ok: true };
}

export async function adminUpdateReviewById(id: string, payload: any): Promise<any> {
  return api.put<any>(`/reviews/${id}`, payload);
}

export async function adminToggleReviewPin(id: string): Promise<any> {
  return api.patch<any>(`/reviews/${id}/pin`, {});
}



// ─── Check admin ───────────────────────────────────────────────────────────

export async function isAdmin(): Promise<{ isAdmin: boolean }> {
  try {
    const data = await api.get<{ success: boolean; user: any }>("/auth/me");
    return { isAdmin: data.user?.role === "admin" };
  } catch {
    return { isAdmin: false };
  }
}

// ─── Users ─────────────────────────────────────────────────────────────────

export async function adminListUsers(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/admin/users${qs ? `?${qs}` : ""}`);
}

export async function adminGetUserById(userId: string): Promise<any> {
  return api.get<any>(`/admin/users/${userId}`);
}

export async function adminGetLoginHistory(userId: string): Promise<any> {
  return api.get<any>(`/admin/users/${userId}/login-history`);
}

export async function adminGetUserActivity(userId: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/admin/users/${userId}/activity${qs ? `?${qs}` : ""}`);
}

export async function adminDeleteUser(userId: string, message = ""): Promise<any> {
  return api.del<any>(`/admin/users/${userId}`);
}

export async function adminBlockUser(userId: string, message = ""): Promise<any> {
  return api.post<any>(`/admin/users/${userId}/block`, { message });
}

export async function adminUnblockUser(blockedId: string): Promise<any> {
  return api.post<any>(`/admin/users/${blockedId}/unblock`);
}

export async function adminUpdateUserProfile(userId: string, data: any): Promise<any> {
  return api.put<any>(`/admin/users/${userId}/profile`, data);
}

export async function adminGetUserTimeStats(userId: string): Promise<any> {
  return api.get<any>(`/admin/users/${userId}/time-stats`);
}

export async function adminSetUserDiscount(userId: string, percent: number): Promise<any> {
  return api.patch<any>(`/admin/users/${userId}/discount`, { percent });
}

export async function adminSetUserLoyaltyPoints(userId: string, points: number, reason?: string): Promise<any> {
  return api.patch<any>(`/admin/users/${userId}/loyalty-points`, { points, reason });
}

// ─── Activity Logs ─────────────────────────────────────────────────────────

export async function adminGetActivityLogs(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/admin/activity-logs${qs ? `?${qs}` : ""}`);
}

// ─── Website Reviews ───────────────────────────────────────────────────────

export async function adminGetWebsiteReviews(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/website-reviews${qs ? `?${qs}` : ""}`);
}

export async function adminUpdateWebsiteReview(id: string, payload: any): Promise<any> {
  return api.put<any>(`/website-reviews/${id}`, payload);
}

export async function adminDeleteWebsiteReview(id: string): Promise<any> {
  return api.del<any>(`/website-reviews/${id}`);
}

export async function adminToggleWebsiteReviewPin(id: string): Promise<any> {
  return api.patch<any>(`/website-reviews/${id}/pin`, {});
}

// ─── User Final Data ───────────────────────────────────────────────────────

export async function adminGetUserFinalData(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/admin/users-final-data${qs ? `?${qs}` : ""}`);
}

export async function adminGenerateUserFinalData(): Promise<any> {
  return api.post<any>("/admin/users-final-data/generate", {});
}



export async function adminListProductsPaginated(params: {
  page?: number;
  limit?: number;
  search?: string;
} = {}): Promise<{ products: any[]; total: number; page: number; totalPages: number }> {
  const { page = 1, limit = 50, search = "" } = params;
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (search) qs.set("search", search);
  const data = await api.get<{ success: boolean; products: any[]; total: number; page: number }>(
    `/products/admin-list?${qs.toString()}`,
  );
  const products = (data.products ?? []).map(normalizeProduct);
  const total = data.total ?? 0;
  const totalPages = Math.ceil(total / limit) || 1;
  return { products, total, page: data.page ?? page, totalPages };
}


export async function recategorizeProducts(): Promise<any> {
  return api.post<any>("/products/recategorize-all", {});
}

export async function getRecategorizeStatus(): Promise<any> {
  return api.get<any>("/products/recategorize-status");
}

// ─── Products (extended) ───────────────────────────────────────────────────

export async function adminGetProductStats(): Promise<any> {
  return api.get<any>("/products/stats");
}

export async function adminGetLeaderboard(): Promise<any> {
  return api.get<any>("/products/leaderboard");
}


export async function adminGetOutOfStock(): Promise<any> {
  return api.get<any>("/products/out-of-stock");
}

export async function adminClearProducts(): Promise<any> {
  return api.del<any>("/products");
}


export async function adminUpdateProduct(id: string, payload: any): Promise<any> {
  return api.put<any>(`/products/${id}`, payload);
}

export async function adminUpdateProductManualPosition(id: string, position: number): Promise<any> {
  return api.patch<any>(`/products/${id}/manual-position`, { position });
}

export async function adminUpdateBulkManualPositions(updates: { productId: string; position: number }[]): Promise<any> {
  return api.put<any>(`/products/manual-positions/bulk`, { updates });
}

export async function adminClearAllManualPositions(): Promise<any> {
  return api.del<any>(`/products/manual-positions`);
}

export async function adminGetProductOrders(productId: string): Promise<any> {
  return api.get<any>(`/products/${productId}/orders`);
}

export async function adminToggleFeaturedOnLanding(id: string, featured: boolean): Promise<any> {
  const response = await fetch(`/api/products/${id}/featured-landing`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ featured }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as any).message || "Failed to toggle featured status");
  return data;
}

export async function adminGetFeaturedLandingProducts(): Promise<any[]> {
  const data = await api.get<{ success: boolean; products: any[] }>("/products/featured-landing?limit=50");
  return data.products ?? [];
}

// Featured order editor — raw products kept light (no normalizeProduct, which
// would drop featuredOrder) so the admin can reorder them.
export async function adminGetFeaturedLandingOrdered(): Promise<
  { _id: string; name: string; imageUrl: string | null; featuredOrder: number | null }[]
> {
  const data = await api.get<{ success: boolean; products: any[] }>("/products/featured-landing?limit=80");
  return (data.products ?? []).map((p: any) => ({
    _id: p._id ?? p.id ?? "",
    name: p.name ?? "",
    imageUrl: p.imageUrl ?? null,
    featuredOrder: typeof p.featuredOrder === "number" ? p.featuredOrder : null,
  }));
}

export async function adminSaveFeaturedOrder(order: string[]): Promise<any> {
  return api.put<any>("/products/featured-order", { order });
}

export async function adminGetFeaturedCount(): Promise<number> {
  const data = await api.get<{ success: boolean; count: number }>("/products/featured-count");
  return data.count ?? 0;
}

// Product Hunting — search existing products (name + category), each result
// carries its own featuredOnLanding flag so the page can show "Added" state.
export async function adminHuntProducts(params: {
  search?: string;
  category?: string;
  limit?: number;
} = {}): Promise<{ products: any[]; total: number }> {
  const { search = "", category = "", limit = 60 } = params;
  const qs = new URLSearchParams();
  if (search.trim()) qs.set("search", search.trim());
  if (category) qs.set("category", category);
  qs.set("limit", String(limit));
  const data = await api.get<{ success: boolean; products: any[]; total: number }>(
    `/products?${qs.toString()}`,
  );
  return { products: (data.products ?? []).map(normalizeProduct), total: data.total ?? 0 };
}

// ─── Add Product (manual catalogue entry) ────────────────────────────────────

/** Upload product images / the product video; returns { url, type } per file. */
export async function adminUploadProductMedia(formData: FormData): Promise<any> {
  const response = await fetch("/api/products/upload-media", {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as any).message || "Upload failed");
  return data;
}

// Create a product from the admin "Add Product" form. The backend assigns the
// public id (kp-00000000001) and requires >= 3 images and exactly 1 video.
export async function adminCreateProduct(input: {
  name: string;
  description: string;
  costPrice: number;
  salePrice: number;
  inStock?: boolean;
  variations?: { id?: string; name?: string; size?: string; color?: string; salePrice?: number; inStock?: boolean }[];
  images: string[];
  video: string;
  category?: string;
  /** Fashion department: "men" | "women" | "unisex". */
  gender?: string;
  weight?: number;
  sku?: string;
  featuredOnLanding?: boolean;
}): Promise<any> {
  return api.post<any>("/products/manual", input);
}

// ─── Shipment Details ────────────────────────────────────────────────────────

export async function adminGetShipments(params: {
  page?: number;
  limit?: number;
  search?: string;
  city?: string;
} = {}): Promise<{ shipments: any[]; total: number; page: number; pages: number }> {
  const { page = 1, limit = 50, search = "", city = "" } = params;
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (search) qs.set("search", search);
  if (city) qs.set("city", city);
  const data = await api.get<{ success: boolean; shipments: any[]; total: number; page: number; pages: number }>(
    `/admin/shipments?${qs.toString()}`,
  );
  return {
    shipments: data.shipments ?? [],
    total: data.total ?? 0,
    page: data.page ?? page,
    pages: data.pages ?? 1,
  };
}

export async function adminGetShipmentStats(): Promise<any> {
  const data = await api.get<{ success: boolean; stats: any }>("/admin/shipments/stats");
  return data.stats ?? {};
}

// Confirm an order from the panel (the WhatsApp flow). Runs the same backend
// handler as the emailed confirmation link, moves the order out of the
// unconfirmed queue into the confirmed queue and credits the order's loyalty
// points exactly once.
export async function adminConfirmOrder(orderId: string): Promise<{
  success: boolean;
  message?: string;
  pointsAwarded?: number;
  alreadyConfirmed?: boolean;
}> {
  return api.post(`/admin/shipments/${orderId}/confirm`, {});
}

// ─── Order Queues (Unconfirmed / Confirmed) ─────────────────────────────────
// The two queues the admin panel works with. Confirming physically moves the
// document between collections: pre_orders is deleted and shipment_records is
// written, with the customer's loyalty points credited in the same step.

export interface OrderQueueParams {
  page?: number;
  limit?: number;
  search?: string;
}

export interface OrderQueuePage {
  orders: any[];
  total: number;
  page: number;
  pages: number;
}

function orderQueueQuery(params: OrderQueueParams): string {
  const { page = 1, limit = 50, search = "" } = params;
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (search) qs.set("search", search);
  return qs.toString();
}

/** Orders placed but not confirmed yet, with the full user + shipment detail. */
export async function adminListUnconfirmedOrders(
  params: OrderQueueParams = {},
): Promise<OrderQueuePage> {
  const data = await api.get<{ success: boolean } & OrderQueuePage>(
    `/admin/order-queue/unconfirmed?${orderQueueQuery(params)}`,
  );
  return {
    orders: data.orders ?? [],
    total: data.total ?? 0,
    page: data.page ?? params.page ?? 1,
    pages: data.pages ?? 1,
  };
}

/** Orders already confirmed, with the loyalty points credited on confirmation. */
export async function adminListConfirmedOrders(
  params: OrderQueueParams = {},
): Promise<OrderQueuePage> {
  const data = await api.get<{ success: boolean } & OrderQueuePage>(
    `/admin/order-queue/confirmed?${orderQueueQuery(params)}`,
  );
  return {
    orders: data.orders ?? [],
    total: data.total ?? 0,
    page: data.page ?? params.page ?? 1,
    pages: data.pages ?? 1,
  };
}

// ─── AI Automations ───────────────────────────────────────────────────────

export async function aiStartDescriptionDoctor(): Promise<any> {
  return api.post<any>("/admin/ai/description-doctor/start", {});
}
export async function aiGetDescriptionDoctorStatus(): Promise<any> {
  return api.get<any>("/admin/ai/description-doctor/status");
}

export async function aiStartTitleOptimizer(): Promise<any> {
  return api.post<any>("/admin/ai/title-optimizer/start", {});
}
export async function aiGetTitleOptimizerStatus(): Promise<any> {
  return api.get<any>("/admin/ai/title-optimizer/status");
}

export async function aiAnalyzeReviews(): Promise<any> {
  return api.post<any>("/admin/ai/review-intelligence", {});
}

export async function aiFindDuplicates(): Promise<any> {
  return api.post<any>("/admin/ai/duplicate-radar", {});
}

export async function aiHideProduct(id: string): Promise<any> {
  const response = await fetch(`/api/admin/ai/products/${id}/hide`, {
    method: "PATCH",
    credentials: "include",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as any).message || "Failed");
  return data;
}

export async function aiGetPoolStatus(): Promise<any> {
  return api.get<any>("/admin/ai/pool-status");
}

// ─── Settings — multi-key Groq management ─────────────────────────────────

export async function adminGetSettings(): Promise<any> {
  return api.get<any>("/admin/settings");
}

// Storefront delivery fee — exposed publicly via /settings/public, editable here
export async function adminUpdateDeliveryFee(deliveryFee: number): Promise<any> {
  return api.put<any>("/admin/settings/delivery-fee", { deliveryFee });
}

// Landing hero diptych ("Objects Considered") — left/right product ids
export async function adminSetHeroObjects(hero: { left: string | null; right: string | null }): Promise<any> {
  return api.put<any>("/admin/settings/hero-objects", hero);
}

// Multi-key endpoints
export async function adminAddGroqKey(payload: { key: string; label: string; task: string }): Promise<any> {
  return api.post<any>("/admin/settings/groq-keys", payload);
}
export async function adminUpdateGroqKey(id: string, payload: { label?: string; task?: string }): Promise<any> {
  return api.put<any>(`/admin/settings/groq-keys/${id}`, payload);
}
export async function adminDeleteGroqKeyById(id: string): Promise<any> {
  return api.del<any>(`/admin/settings/groq-keys/${id}`);
}
export async function adminTestGroqKeyById(id: string): Promise<any> {
  return api.post<any>(`/admin/settings/groq-keys/${id}/test`, {});
}

// Legacy (kept for compat)
export async function adminSaveGroqKey(key: string): Promise<any> {
  return api.put<any>("/admin/settings/groq-key", { key });
}
export async function adminDeleteGroqKey(): Promise<any> {
  return api.del<any>("/admin/settings/groq-key");
}
export async function adminTestGroqKey(key?: string): Promise<any> {
  return api.post<any>("/admin/settings/groq-key/test", { key: key ?? "" });
}

// ─── AI Studio — new automations ──────────────────────────────────────────

export async function aiStartSeoBooster(): Promise<any> {
  return api.post<any>("/admin/ai/seo-booster/start", {});
}
export async function aiGetSeoBoosterStatus(): Promise<any> {
  return api.get<any>("/admin/ai/seo-booster/status");
}

export async function aiStartCategoryFixer(): Promise<any> {
  return api.post<any>("/admin/ai/category-fixer/start", {});
}
export async function aiGetCategoryFixerStatus(): Promise<any> {
  return api.get<any>("/admin/ai/category-fixer/status");
}

// ─── Order Status Management (main order tracking) ──────────────────────────
// Sourced from the shipment queue (confirmed orders), so pending confirmations
// never appear here.

export async function adminListTrackedOrders(params: {
  page?: number;
  limit?: number;
} = {}): Promise<{ orders: any[]; pagination: any }> {
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  return api.get<any>(`/admin/order-status${qs.toString() ? `?${qs.toString()}` : ""}`);
}

export async function adminUpdateTrackedOrderStatus(
  id: string,
  status: string,
): Promise<{ ok: boolean }> {
  await api.patch(`/admin/order-status/${id}`, { status });
  return { ok: true };
}

// ─── Orders (extended) ────────────────────────────────────────────────────

export async function adminFinalizeOrder(orderId: string): Promise<any> {
  return api.post<any>(`/orders/finalize/${orderId}`, {});
}


// ─── Defective Product Reports ────────────────────────────────────────────────

export async function adminGetDefectiveReports(params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  return api.get<any>(`/defective-products${qs ? `?${qs}` : ""}`);
}

export async function adminGetDefectiveReportById(id: string): Promise<any> {
  return api.get<any>(`/defective-products/${id}`);
}

export async function adminUpdateDefectiveReportStatus(id: string, payload: { status: string; adminNote?: string }): Promise<any> {
  return api.patch<any>(`/defective-products/${id}`, payload);
}
