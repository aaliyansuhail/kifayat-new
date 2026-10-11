import { api } from "./api";

export type InteractionTotals = {
  views: number;
  clicks: number;
  hovers: number;
  pageviews: number;
  events: number;
  uniqueVisitors: number;
  clickThroughRate: number;
  clicksPerVisitor: number;
  hoversPerVisitor: number;
  hoverToClickRate: number;
  clickToPageRate: number;
};

export type InteractionProduct = {
  productId: string;
  name: string;
  image: string | null;
  salePrice: number;
  stock: number;
  views: number;
  clicks: number;
  hovers: number;
  pageviews: number;
  visitors: number;
  ctr: number;
  hoverToClick: number;
};

export type InteractionAnalytics = {
  range: { days: number; since: string };
  totals: InteractionTotals;
  previousTotals: { views: number; clicks: number; hovers: number; pageviews: number };
  timeline: { date: string; views: number; clicks: number; hovers: number; pageviews: number }[];
  byType: { type: string; events: number; visitors: number; previous: number }[];
  devices: { device: string; count: number; share: number }[];
  referrers: { referrer: string; count: number }[];
  products: InteractionProduct[];
  recent: {
    _id: string;
    type: string;
    createdAt: string;
    productName: string | null;
    productImage: string | null;
    userAgent: string | null;
    referrer: string | null;
  }[];
};

/** Hover / click / view analytics for the signed-in seller's products. */
export async function fetchInteractionAnalytics(days = 30): Promise<InteractionAnalytics> {
  const data = await api.get<{ success: boolean; interactions: InteractionAnalytics }>(
    `/seller/analytics/interactions?days=${days}`,
  );
  return data.interactions;
}

export type SellerInteractionSummary = {
  allTime: { views: number; clicks: number; hovers: number; pageviews: number };
  last30Days: {
    views: number;
    clicks: number;
    hovers: number;
    pageviews: number;
    uniqueVisitors: number;
  };
};

export type SellerAnalytics = {
  totalProducts: number;
  totalSales: number;
  totalRevenue: number;
  totalItemsSold: number;
  recentOrders: any[];
  interactions?: SellerInteractionSummary;
};

export async function fetchSellerAnalytics(): Promise<SellerAnalytics> {
  const data = await api.get<{ success: boolean; analytics: SellerAnalytics }>("/seller/analytics");
  return data.analytics;
}

export type SellerVariation = {
  id?: string;
  name?: string;
  costPrice?: number;
  salePrice?: number;
  quantity?: number;
  sku?: string;
  variation_image?: { original_url?: string };
};

export type SellerProduct = {
  _id: string;
  name: string;
  slug?: string;
  category?: string;
  description?: string;
  sku?: string;
  productId?: string;
  costPrice?: number;
  salePrice?: number;
  stock?: number;
  weight?: number;
  imageUrl?: string;
  videoUrl?: string;
  gallery?: { id?: unknown; url: string; type?: string }[];
  variations?: SellerVariation[];
  keywords?: string[];
  seoTitle?: string;
  seoDescription?: string;
  hidden?: boolean;
  deleted?: boolean;
  createdAt?: string;
};

export type SellerProductsResponse = {
  success: boolean;
  products: SellerProduct[];
};

export async function fetchSellerProducts(): Promise<SellerProduct[]> {
  // One request for the whole catalogue — the seller list is a management view,
  // not a paginated storefront grid.
  const data = await api.get<SellerProductsResponse>("/seller/products?limit=200");
  return data.products ?? [];
}

// ─── Seller product create / update / delete ─────────────────────────────────

export type SellerProductPayload = {
  name: string;
  description: string;
  category: string;
  sku: string;
  productId: string;
  costPrice: number;
  salePrice: number;
  stock: number;
  weight: number;
  images: string[];
  videoUrl: string;
  keywords: string[];
  seoTitle: string;
  seoDescription: string;
  variations: {
    name: string;
    costPrice: number;
    salePrice: number;
    quantity: number;
    sku: string;
    image: string;
  }[];
};

export async function createSellerProduct(
  payload: SellerProductPayload,
): Promise<{ message: string; product: SellerProduct }> {
  return api.post("/seller/products", payload);
}

export async function updateSellerProduct(
  id: string,
  payload: SellerProductPayload,
): Promise<{ message: string; product: SellerProduct }> {
  return api.put(`/seller/products/${id}`, payload);
}

export async function deleteSellerProduct(id: string): Promise<{ message: string }> {
  return api.del(`/seller/products/${id}`);
}

// ─── Gallery uploads ─────────────────────────────────────────────────────────

export type UploadedMedia = {
  url: string;
  type: "image" | "video";
  mimeType: string;
  name: string;
  size: number;
};

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

/**
 * Upload gallery images/videos. Multipart, so it bypasses the JSON `api`
 * helper: progress is tracked locally and the returned URLs are relative
 * (/uploads/...) so they work behind the Vite proxy unchanged.
 */
export async function uploadSellerMedia(
  files: File[],
  onProgress?: (percent: number) => void,
): Promise<{ files: UploadedMedia[]; rejected: { name: string; reason: string }[] }> {
  if (files.length === 0) throw new Error("Choose at least one image or video to upload.");

  const tooBig = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
  if (tooBig.length) {
    throw new Error(
      `${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over the 40 MB limit.`,
    );
  }

  const form = new FormData();
  files.forEach((f) => form.append("files", f));

  // XHR rather than fetch: it is the only way to get a real upload progress bar.
  const data = await new Promise<any>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/seller/upload-media");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.success) return resolve(body);
      reject(new Error(body?.message || `Upload failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check your connection."));
    xhr.send(form);
  });

  return { files: data.files ?? [], rejected: data.rejected ?? [] };
}
