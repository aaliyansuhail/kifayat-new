import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Image as ImageIcon,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Loader2,
  Upload,
  Video,
  Link2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { listCategories } from "@/lib/shop.functions";
import { uploadSellerMedia } from "@/lib/seller-analytics.functions";
import { toast } from "sonner";

const MAX_IMAGES = 10;
const MAX_VIDEOS = 3;

export type SellerVariation = {
  name: string;
  costPrice: string;
  salePrice: string;
  quantity: string;
  sku: string;
  image: string;
};

export type SellerProductDraft = {
  name: string;
  description: string;
  category: string;
  newCategory: string;
  /** Fashion department: "unisex" | "men" | "women". */
  gender: string;
  sku: string;
  productId: string;
  costPrice: string;
  salePrice: string;
  stock: string;
  weight: string;
  images: string[];
  videos: string[];
  videoUrl: string;
  variations: SellerVariation[];
  keywords: string;
  seoTitle: string;
  seoDescription: string;
};

export const emptyDraft = (): SellerProductDraft => ({
  name: "",
  description: "",
  category: "",
  newCategory: "",
  gender: "unisex",
  sku: "",
  productId: "",
  costPrice: "",
  salePrice: "",
  stock: "",
  weight: "",
  images: [""],
  videos: [],
  videoUrl: "",
  variations: [],
  keywords: "",
  seoTitle: "",
  seoDescription: "",
});

/** Map an existing product document into the editable draft shape. */
export function toDraft(product: any): SellerProductDraft {
  const fromGallery = Array.isArray(product?.gallery) ? product.gallery : null;
  const images: string[] = fromGallery
    ? fromGallery.filter((g: any) => g?.type !== "video").map((g: any) => g.url)
    : String(product?.imageUrl ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const videos: string[] = fromGallery
    ? fromGallery.filter((g: any) => g?.type === "video").map((g: any) => g.url)
    : String(product?.videoUrl ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  return {
    name: product?.name ?? "",
    description: product?.description ?? "",
    category: product?.category ?? "",
    newCategory: "",
    gender: product?.gender ?? "unisex",
    sku: product?.sku ?? "",
    productId: product?.productId ?? "",
    costPrice: product?.costPrice != null ? String(product.costPrice) : "",
    salePrice: product?.salePrice != null ? String(product.salePrice) : "",
    stock: product?.stock != null ? String(product.stock) : "",
    weight: product?.weight != null ? String(product.weight) : "",
    images: images.length ? images : [""],
    videos,
    videoUrl: product?.videoUrl ?? "",
    variations: (product?.variations ?? []).map((v: any) => ({
      name: v?.name ?? "",
      costPrice: v?.costPrice != null ? String(v.costPrice) : "",
      salePrice: v?.salePrice != null ? String(v.salePrice) : "",
      quantity: v?.quantity != null ? String(v.quantity) : "",
      sku: v?.sku ?? "",
      image: v?.variation_image?.original_url ?? v?.image ?? "",
    })),
    keywords: Array.isArray(product?.keywords) ? product.keywords.join(", ") : "",
    seoTitle: product?.seoTitle ?? "",
    seoDescription: product?.seoDescription ?? "",
  };
}

/** Draft → API payload (the backend does the real validation and slugging). */
export function draftToPayload(draft: SellerProductDraft) {
  const category = (draft.newCategory || draft.category || "").trim();
  const n = (v: string) => (v.trim() === "" ? 0 : Number(v));

  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    category,
    gender: (draft.gender || "unisex").trim().toLowerCase(),
    sku: draft.sku.trim(),
    productId: draft.productId.trim(),
    costPrice: n(draft.costPrice),
    salePrice: n(draft.salePrice),
    stock: n(draft.stock),
    weight: n(draft.weight),
    images: draft.images.map((u) => u.trim()).filter(Boolean),
    videos: [
      ...draft.videos.map((u) => u.trim()).filter(Boolean),
      ...(draft.videoUrl.trim() ? [draft.videoUrl.trim()] : []),
    ],
    videoUrl: draft.videoUrl.trim(),
    keywords: draft.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    seoTitle: draft.seoTitle.trim(),
    seoDescription: draft.seoDescription.trim(),
    variations: draft.variations
      .filter((v) => v.name.trim())
      .map((v) => ({
        name: v.name.trim(),
        costPrice: n(v.costPrice),
        salePrice: n(v.salePrice),
        quantity: n(v.quantity),
        sku: v.sku.trim(),
        image: v.image.trim(),
      })),
  };
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-coal/10 pt-5 first:border-0 first:pt-0">
      <h3 className="text-sm font-semibold text-coal">{title}</h3>
      {hint && <p className="text-xs text-coal/50 mt-0.5 mb-3">{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
  hint,
  required,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-coal/45">{hint}</p>}
    </div>
  );
}

const numOf = (v: string) => (v.trim() === "" || Number.isNaN(Number(v)) ? 0 : Number(v));

export function SellerProductForm({
  draft,
  onChange,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  draft: SellerProductDraft;
  onChange: (next: SellerProductDraft) => void;
  pending?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof SellerProductDraft>(key: K, value: SellerProductDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const { data: categories = [], isLoading: catsLoading } = useQuery({
    queryKey: ["categories"],
    queryFn: listCategories,
    staleTime: 5 * 60 * 1000,
  });

  const markup = useMemo(() => {
    const w = numOf(draft.costPrice);
    const r = numOf(draft.salePrice);
    if (w <= 0 || r <= 0) return null;
    return Math.round(((r - w) / w) * 100);
  }, [draft.costPrice, draft.salePrice]);

  const variationStock = useMemo(
    () => draft.variations.reduce((sum, v) => sum + numOf(v.quantity), 0),
    [draft.variations],
  );

  const setImage = (i: number, url: string) => {
    const next = [...draft.images];
    next[i] = url;
    set("images", next);
  };

  // ── Media upload ───────────────────────────────────────────────────────────
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;

    // Filter to what the endpoint accepts before spending bandwidth.
    const allowed = files.filter((f) =>
      /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/i.test(f.type),
    );
    const rejected = files.length - allowed.length;
    if (!allowed.length) {
      toast.error("Only JPEG, PNG, WebP, GIF, MP4, WebM and MOV files are accepted.");
      return;
    }

    const usedImages = draft.images.filter((u) => u.trim()).length;
    const usedVideos = draft.videos.length;
    const room = Math.max(0, MAX_IMAGES - usedImages) + Math.max(0, MAX_VIDEOS - usedVideos);
    if (allowed.length > room) {
      toast.error(`You can only add ${room} more file${room === 1 ? "" : "s"} to this product.`);
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    try {
      const res = await uploadSellerMedia(allowed, setUploadProgress);
      const newImages = res.files.filter((f) => f.type === "image").map((f) => f.url);
      const newVideos = res.files.filter((f) => f.type === "video").map((f) => f.url);

      // One composed update: `set` spreads the draft it closed over, so several
      // sequential calls would each discard the previous one's change.
      const patch: Partial<SellerProductDraft> = {};

      if (newImages.length) {
        // Append after the last filled row so ordering stays user-controlled.
        const next = [...draft.images];
        while (next.length && !next[next.length - 1].trim()) next.pop();
        patch.images = [...next, ...newImages].slice(0, MAX_IMAGES);
      }

      if (newVideos.length) {
        const next = [...draft.videos];
        for (const v of newVideos) {
          if (next.length >= MAX_VIDEOS) break;
          if (!next.includes(v)) next.push(v);
        }
        patch.videos = next;
        // Keep the legacy single-video field pointing at the first upload.
        if (!draft.videoUrl.trim() && next[0]) patch.videoUrl = next[0];
      }

      if (Object.keys(patch).length) onChange({ ...draft, ...patch });

      const notes = [
        `${res.files.length} file${res.files.length === 1 ? "" : "s"} uploaded`,
        rejected ? `${rejected} unsupported skipped` : "",
        ...res.rejected.map((r) => `${r.name}: ${r.reason}`),
      ].filter(Boolean);
      toast.success(notes.join(" · "));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const updateVariation = (i: number, patch: Partial<SellerVariation>) => {
    const next = [...draft.variations];
    next[i] = { ...next[i], ...patch };
    set("variations", next);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-6"
    >
      {/* Basics */}
      <Section title="Basics">
        <div className="space-y-3">
          <Field label="Product name" required>
            <Input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Wireless Bluetooth Earbuds TWS-5"
              required
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Category" required>
              {catsLoading ? (
                <div className="flex items-center gap-2 text-xs text-coal/45 h-9">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> loading categories…
                </div>
              ) : (
                <select
                  value={draft.category}
                  onChange={(e) => set("category", e.target.value)}
                  className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
                >
                  <option value="">Select a category…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                  <option value="__new__">+ New category…</option>
                </select>
              )}
            </Field>

            {draft.category === "__new__" && (
              <Field label="New category name" required>
                <Input
                  value={draft.newCategory}
                  onChange={(e) => set("newCategory", e.target.value)}
                  placeholder="e.g. Home"
                  required
                />
              </Field>
            )}
          </div>

          <Field label="Shop for" hint="Drives the Men/Women filter on the Fashion category — Unisex appears under both.">
            <select
              value={draft.gender || "unisex"}
              onChange={(e) => set("gender", e.target.value)}
              className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm"
            >
              <option value="unisex">Unisex</option>
              <option value="men">Men</option>
              <option value="women">Women</option>
            </select>
          </Field>

          <Field label="Description" hint="Line breaks become bullet points on the product page.">
            <Textarea
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              rows={5}
              placeholder={'Features\nWhat is in the box\nDelivery & warranty'}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="SKU" hint="Optional internal code.">
              <Input value={draft.sku} onChange={(e) => set("sku", e.target.value)} />
            </Field>
            <Field label="Product ID" hint="Optional supplier/reference ID.">
              <Input value={draft.productId} onChange={(e) => set("productId", e.target.value)} />
            </Field>
          </div>
        </div>
      </Section>

      {/* Pricing */}
      <Section
        title="Pricing"
        hint="The sale price is what customers pay. The cost price stays private."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Cost price (Rs)" required>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={draft.costPrice}
              onChange={(e) => set("costPrice", e.target.value)}
              required
            />
          </Field>
          <Field label="Sale price (Rs)" required>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={draft.salePrice}
              onChange={(e) => set("salePrice", e.target.value)}
              placeholder="0"
              required
            />
          </Field>
          <div className="space-y-1.5">
            <Label className="text-xs">Markup</Label>
            <div className="h-9 flex items-center rounded-md border border-dashed border-coal/15 px-3 text-sm tabular-nums">
              {markup === null ? (
                <span className="text-coal/40">—</span>
              ) : (
                <span className={markup < 0 ? "text-red-600" : "text-emerald-700"}>
                  {markup}%
                </span>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* Inventory */}
      <Section
        title="Inventory"
        hint={
          draft.variations.length
            ? `Stock is taken from your options (${variationStock} units total).`
            : undefined
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Stock quantity" required={!draft.variations.length}>
            <Input
              type="number"
              min="0"
              value={draft.stock}
              onChange={(e) => set("stock", e.target.value)}
              disabled={draft.variations.length > 0}
              required={!draft.variations.length}
            />
          </Field>
          <Field label="Weight (kg)" hint="Used for courier estimates.">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={draft.weight}
              onChange={(e) => set("weight", e.target.value)}
              placeholder="0.5"
            />
          </Field>
        </div>
      </Section>

      {/* Media */}
      <Section
        title="Media"
        hint="Upload images and videos, or paste a URL. The first image is the card image."
      >
        <div className="space-y-3">
          {/* Upload dropzone */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void handleFiles(Array.from(e.dataTransfer.files));
            }}
            className={`rounded-xl border-2 border-dashed px-4 py-6 text-center transition cursor-pointer ${
              dragging
                ? "border-brass bg-brass/5"
                : "border-coal/15 hover:border-coal/30 hover:bg-bone/60"
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
              multiple
              className="hidden"
              onChange={(e) => {
                void handleFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            {uploading ? (
              <>
                <Loader2 className="h-5 w-5 mx-auto mb-2 animate-spin text-coal/50" />
                <p className="text-sm text-coal/70">Uploading… {uploadProgress}%</p>
                <div className="mt-2 mx-auto h-1 w-48 rounded-full bg-coal/10 overflow-hidden">
                  <div
                    className="h-full bg-brass transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 mx-auto mb-2 text-coal/40" />
                <p className="text-sm text-coal/70">
                  <span className="font-medium text-coal">Click to upload</span> or drag &amp; drop
                </p>
                <p className="text-[11px] text-coal/45 mt-1">
                  JPEG, PNG, WebP, GIF · MP4, WebM, MOV — up to 40 MB each
                </p>
              </>
            )}
          </div>

          {/* Video chips */}
          {draft.videos.length > 0 && (
            <div className="space-y-1.5">
              {draft.videos.map((url, i) => (
                <div
                  key={`${url}-${i}`}
                  className="flex items-center gap-2 rounded-md border border-coal/10 px-2 py-1.5"
                >
                  <Video className="h-4 w-4 shrink-0 text-coal/45" />
                  <video
                    src={url}
                    className="h-9 w-12 shrink-0 rounded bg-coal/5 object-cover"
                    muted
                    playsInline
                    preload="metadata"
                  />
                  <span className="flex-1 truncate text-xs text-coal/70">{url}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Remove video"
                    onClick={() =>
                      set(
                        "videos",
                        draft.videos.filter((_, idx) => idx !== i),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Image rows */}
          {draft.images.map((url, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="size-11 shrink-0 rounded-md border border-coal/10 bg-bone grid place-items-center overflow-hidden">
                {url.trim() ? (
                  <img
                    src={url.trim().split("?")[0]}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                    }}
                  />
                ) : (
                  <ImageIcon className="h-4 w-4 text-coal/25" />
                )}
              </div>
              <Input
                value={url}
                onChange={(e) => setImage(i, e.target.value)}
                placeholder="https://…/image.jpg"
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={i === 0}
                title="Move up"
                onClick={() => {
                  const next = [...draft.images];
                  [next[i - 1], next[i]] = [next[i], next[i - 1]];
                  set("images", next);
                }}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={i === draft.images.length - 1}
                title="Move down"
                onClick={() => {
                  const next = [...draft.images];
                  [next[i + 1], next[i]] = [next[i], next[i + 1]];
                  set("images", next);
                }}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Remove image"
                disabled={draft.images.length === 1 && !draft.images[0]}
                onClick={() =>
                  set(
                    "images",
                    draft.images.length === 1 ? [""] : draft.images.filter((_, idx) => idx !== i),
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            {draft.images.length < MAX_IMAGES && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => set("images", [...draft.images, ""])}
              >
                <Link2 className="h-3.5 w-3.5 mr-1.5" /> Add image URL
              </Button>
            )}
            {draft.videos.length < MAX_VIDEOS && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const url = window.prompt("Video URL (mp4 / webm)");
                  if (url && url.trim()) set("videos", [...draft.videos, url.trim()]);
                }}
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Add video URL
              </Button>
            )}
          </div>

          <p className="text-[11px] text-coal/45">
            {draft.images.filter((u) => u.trim()).length}/{MAX_IMAGES} images ·{" "}
            {draft.videos.length}/{MAX_VIDEOS} videos
          </p>
        </div>
      </Section>

      {/* Options / variations */}
      <Section
        title="Options / variations"
        hint="Add size, colour or model options. Each option gets its own price and stock."
      >
        <div className="space-y-3">
          {draft.variations.map((v, i) => (
            <div key={i} className="rounded-lg border border-coal/10 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-coal/60">Option {i + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Remove option"
                  onClick={() =>
                    set("variations", draft.variations.filter((_, idx) => idx !== i))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Option name" required>
                  <Input
                    value={v.name}
                    onChange={(e) => updateVariation(i, { name: e.target.value })}
                    placeholder="e.g. Black"
                  />
                </Field>
                <Field label="SKU">
                  <Input value={v.sku} onChange={(e) => updateVariation(i, { sku: e.target.value })} />
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="Wholesale (Rs)">
                  <Input
                    type="number"
                    min="0"
                    value={v.costPrice}
                    onChange={(e) =>
                      updateVariation(i, { costPrice: e.target.value })
                    }
                    placeholder={draft.costPrice || "0"}
                  />
                </Field>
                <Field label="Retail (Rs)">
                  <Input
                    type="number"
                    min="0"
                    value={v.salePrice}
                    onChange={(e) => updateVariation(i, { salePrice: e.target.value })}
                    placeholder={draft.salePrice || "auto"}
                  />
                </Field>
                <Field label="Quantity" required>
                  <Input
                    type="number"
                    min="0"
                    value={v.quantity}
                    onChange={(e) => updateVariation(i, { quantity: e.target.value })}
                  />
                </Field>
              </div>
              <Field label="Option image URL">
                <Input
                  value={v.image}
                  onChange={(e) => updateVariation(i, { image: e.target.value })}
                  placeholder="https://…/black.jpg"
                />
              </Field>
            </div>
          ))}

          {draft.variations.length < 30 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                set("variations", [
                  ...draft.variations,
                  {
                    name: "",
                    costPrice: draft.costPrice,
                    salePrice: draft.salePrice,
                    quantity: "",
                    sku: "",
                    image: "",
                  },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add option
            </Button>
          )}
        </div>
      </Section>

      {/* SEO */}
      <Section
        title="SEO"
        hint="Leave keywords blank and we'll generate them from the name and category."
      >
        <div className="space-y-3">
          <Field label="Keywords" hint="Comma separated.">
            <Input
              value={draft.keywords}
              onChange={(e) => set("keywords", e.target.value)}
              placeholder="wireless earbuds, bluetooth earbuds pakistan, tws"
            />
          </Field>
          <Field label="SEO title">
            <Input
              value={draft.seoTitle}
              onChange={(e) => set("seoTitle", e.target.value)}
              placeholder={draft.name ? `${draft.name} — Kifayat` : ""}
            />
          </Field>
          <Field label="SEO description">
            <Textarea
              value={draft.seoDescription}
              onChange={(e) => set("seoDescription", e.target.value)}
              rows={2}
            />
          </Field>
        </div>
      </Section>

      <div className="flex justify-end gap-2 border-t border-coal/10 pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
