import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  CheckCircle2,
  ImagePlus,
  Loader2,
  Plus,
  Save,
  Trash2,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { adminCreateProduct, adminUploadProductMedia } from "@/lib/admin.functions";
import { listCategories } from "@/lib/shop.functions";

export const Route = createFileRoute("/_authenticated/admin/add-product")({
  component: AdminAddProduct,
});

const inputClass =
  "w-full px-4 py-3 bg-background border border-border rounded-xl text-sm font-medium text-foreground focus:outline-none focus:border-brass focus:ring-2 focus:ring-brass/30 transition-all";

const MIN_IMAGES = 3;

type VariationDraft = {
  id: string;
  size: string;
  color: string;
  salePrice: string;
  inStock: boolean;
};

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {required && <span className="text-[10px] font-bold text-brass">REQUIRED</span>}
      </span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function AdminAddProduct() {
  const navigate = useNavigate();
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    name: "",
    description: "",
    category: "",
    gender: "unisex",
    costPrice: "",
    salePrice: "",
    weight: "",
    sku: "",
  });
  const [inStock, setInStock] = useState(true);
  const [variations, setVariations] = useState<VariationDraft[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [video, setVideo] = useState("");
  const [imageUrlDraft, setImageUrlDraft] = useState("");
  const [uploading, setUploading] = useState(false);

  const { data: categoryData } = useQuery({
    queryKey: ["categories"],
    queryFn: listCategories,
  });
  const categories: { name: string }[] = (categoryData as any)?.categories ?? [];

  const set = (key: keyof typeof form, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const addVariation = () =>
    setVariations((prev) => [
      ...prev,
      { id: `var-${Date.now()}-${prev.length}`, size: "", color: "", salePrice: "", inStock: true },
    ]);

  const updateVariation = (idx: number, patch: Partial<VariationDraft>) =>
    setVariations((prev) => prev.map((v, i) => (i === idx ? { ...v, ...patch } : v)));

  const removeVariation = (idx: number) =>
    setVariations((prev) => prev.filter((_, i) => i !== idx));

  const createMut = useMutation({
    mutationFn: () =>
      adminCreateProduct({
        name: form.name.trim(),
        description: form.description.trim(),
        category: form.category.trim() || undefined,
        gender: form.gender,
        costPrice: Number(form.costPrice) || 0,
        salePrice: Number(form.salePrice) || 0,
        inStock,
        variations: variations
          .map((v, i) => ({
            id: v.id || `var-${i + 1}`,
            name: [v.color, v.size].filter(Boolean).join(" ").trim(),
            size: v.size.trim(),
            color: v.color.trim(),
            salePrice: Number(v.salePrice) || 0,
            inStock: v.inStock,
          }))
          .filter((v) => v.size || v.color),
        weight: form.weight === "" ? undefined : Number(form.weight) || 0,
        sku: form.sku.trim() || undefined,
        images,
        video,
      }),
    onSuccess: (res: any) => {
      toast.success(res?.message ?? "Product created.");
      setForm({ name: "", description: "", category: "", gender: "unisex", costPrice: "", salePrice: "", weight: "", sku: "" });
      setInStock(true);
      setVariations([]);
      setImages([]);
      setVideo("");
      navigate({ to: "/admin/products" });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to create product."),
  });

  async function uploadFiles(files: FileList | null, kind: "image" | "video") {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("files", f));
      const res = await adminUploadProductMedia(fd);
      const uploaded: { url: string; type: string }[] = res?.files ?? [];
      const picked = uploaded.filter((f) => f.type === kind);
      if (kind === "image") {
        setImages((prev) => [...prev, ...picked.map((f) => f.url)]);
      } else {
        setVideo(picked[0]?.url ?? "");
      }
      if (picked.length === 0) {
        toast.error(kind === "image" ? "No image files were uploaded." : "No video file was uploaded.");
      } else {
        toast.success(kind === "image" ? `${picked.length} image(s) uploaded.` : "Video uploaded.");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed.");
    } finally {
      setUploading(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
      if (videoInputRef.current) videoInputRef.current.value = "";
    }
  }

  const addImageUrl = () => {
    const url = imageUrlDraft.trim();
    if (!url) return;
    setImages((prev) => [...prev, url]);
    setImageUrlDraft("");
  };

  const canSubmit =
    form.name.trim().length > 0 &&
    form.description.trim().length > 0 &&
    Number(form.salePrice) > 0 &&
    Number(form.costPrice) >= 0 &&
    images.length >= MIN_IMAGES &&
    video.length > 0 &&
    !createMut.isPending &&
    !uploading;

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="text-sm font-medium text-muted-foreground tracking-wide">Catalog</p>
        <h1 className="font-display italic text-3xl lg:text-4xl mt-1 font-bold tracking-tight text-foreground">
          Add Product<span className="text-brass">.</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-2">
          The sale price is what customers pay and what every discount and voucher is
          calculated from. The cost price stays private.
        </p>
      </div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="grid gap-6 lg:grid-cols-[1.4fr_1fr]"
      >
        {/* ── Details ───────────────────────────────────────────────────── */}
        <div className="space-y-6 rounded-2xl border border-border bg-card p-6">
          <Field label="Product name" required>
            <input
              className={inputClass}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Wireless Earbuds Pro"
            />
          </Field>

          <Field label="Description" required>
            <textarea
              className={`${inputClass} min-h-[140px] resize-y`}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="What the customer should know about this product…"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sale price (Rs)" required hint="Shown to customers.">
              <input
                className={inputClass}
                type="number"
                min={0}
                value={form.salePrice}
                onChange={(e) => set("salePrice", e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Cost price (Rs)" required hint="Private — what you pay to buy it.">
              <input
                className={inputClass}
                type="number"
                min={0}
                value={form.costPrice}
                onChange={(e) => set("costPrice", e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Availability">
              <button
                type="button"
                onClick={() => setInStock((v) => !v)}
                className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold transition ${
                  inStock
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                    : "border-red-500/30 bg-red-500/10 text-red-600"
                }`}
              >
                {inStock ? "In stock" : "Out of stock"}
                <span
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
                    inStock ? "bg-emerald-500" : "bg-red-400"
                  }`}
                >
                  <span
                    className={`absolute size-4 rounded-full bg-white transition ${
                      inStock ? "left-[18px]" : "left-0.5"
                    }`}
                  />
                </span>
              </button>
            </Field>
            <Field label="Category">
              <input
                className={inputClass}
                list="add-product-categories"
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                placeholder="Uncategorized"
              />
              <datalist id="add-product-categories">
                {categories.map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            </Field>
            <Field label="Shop for" hint="Fashion department — unisex shows under both Men and Women.">
              <select
                className={inputClass}
                value={form.gender}
                onChange={(e) => set("gender", e.target.value)}
              >
                <option value="unisex">Unisex</option>
                <option value="men">Men</option>
                <option value="women">Women</option>
              </select>
            </Field>
            <Field label="Weight (kg)">
              <input
                className={inputClass}
                type="number"
                min={0}
                step="0.01"
                value={form.weight}
                onChange={(e) => set("weight", e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="SKU (optional)">
              <input
                className={inputClass}
                value={form.sku}
                onChange={(e) => set("sku", e.target.value)}
                placeholder="Internal code"
              />
            </Field>
          </div>

          {/* ── Options / variations ─────────────────────────────────────── */}
          <div className="space-y-4 border-t border-border pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Size / colour options
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Optional — customers pick one option. Each option is either in stock or out of stock.
                </p>
              </div>
              <button
                type="button"
                onClick={addVariation}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:border-brass hover:text-brass"
              >
                <Plus size={14} /> Add option
              </button>
            </div>

            {variations.length > 0 && (
              <div className="space-y-3">
                {variations.map((v, i) => (
                  <div
                    key={v.id}
                    className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-secondary/30 p-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto]"
                  >
                    <input
                      className={inputClass}
                      value={v.size}
                      onChange={(e) => updateVariation(i, { size: e.target.value })}
                      placeholder="Size (e.g. M)"
                    />
                    <input
                      className={inputClass}
                      value={v.color}
                      onChange={(e) => updateVariation(i, { color: e.target.value })}
                      placeholder="Colour (e.g. Black)"
                    />
                    <input
                      className={inputClass}
                      type="number"
                      min={0}
                      value={v.salePrice}
                      onChange={(e) => updateVariation(i, { salePrice: e.target.value })}
                      placeholder="Price (Rs)"
                    />
                    <button
                      type="button"
                      onClick={() => updateVariation(i, { inStock: !v.inStock })}
                      className={`rounded-xl border px-3 py-3 text-xs font-bold transition ${
                        v.inStock
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                          : "border-red-500/30 bg-red-500/10 text-red-600"
                      }`}
                    >
                      {v.inStock ? "In stock" : "Out"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeVariation(i)}
                      className="grid place-items-center rounded-xl border border-border px-3 text-muted-foreground transition hover:border-red-500/40 hover:text-red-500"
                      aria-label="Remove option"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Media ─────────────────────────────────────────────────────── */}
        <div className="space-y-6 rounded-2xl border border-border bg-card p-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Images — at least {MIN_IMAGES}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {images.length}/{MIN_IMAGES} added
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {images.map((url, i) => (
              <div key={`${url}-${i}`} className="group relative overflow-hidden rounded-xl border border-border bg-secondary/40">
                <img src={url} alt={`Product image ${i + 1}`} className="h-24 w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100"
                  aria-label={`Remove image ${i + 1}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              className="grid h-24 place-items-center rounded-xl border border-dashed border-border text-muted-foreground transition hover:border-brass hover:text-brass"
            >
              {uploading ? <Loader2 className="animate-spin" size={18} /> : <ImagePlus size={18} />}
            </button>
          </div>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => uploadFiles(e.target.files, "image")}
          />

          <div className="flex gap-2">
            <input
              className={inputClass}
              value={imageUrlDraft}
              onChange={(e) => setImageUrlDraft(e.target.value)}
              placeholder="…or paste an image URL"
            />
            <button
              type="button"
              onClick={addImageUrl}
              className="shrink-0 rounded-xl border border-border px-3 text-muted-foreground transition hover:border-brass hover:text-brass"
              aria-label="Add image URL"
            >
              <Plus size={16} />
            </button>
          </div>

          <div className="space-y-3 border-t border-border pt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Video — at least 1
            </p>
            {video ? (
              <div className="relative overflow-hidden rounded-xl border border-border bg-secondary/40">
                <video src={video} className="h-32 w-full object-cover" controls muted />
                <button
                  type="button"
                  onClick={() => setVideo("")}
                  className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                  aria-label="Remove video"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => videoInputRef.current?.click()}
                className="grid h-24 w-full place-items-center rounded-xl border border-dashed border-border text-muted-foreground transition hover:border-brass hover:text-brass"
              >
                {uploading ? <Loader2 className="animate-spin" size={18} /> : <Video size={18} />}
              </button>
            )}
            <input
              ref={videoInputRef}
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => uploadFiles(e.target.files, "video")}
            />
            <input
              className={inputClass}
              value={video}
              onChange={(e) => setVideo(e.target.value)}
              placeholder="…or paste a video URL"
            />
          </div>

          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => createMut.mutate()}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-5 py-3 text-sm font-semibold text-background transition disabled:cursor-not-allowed disabled:opacity-40"
          >
            {createMut.isPending ? (
              <Loader2 className="animate-spin" size={16} />
            ) : (
              <Save size={16} />
            )}
            Publish product
          </button>

          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {[
              [form.name.trim().length > 0, "Name"],
              [form.description.trim().length > 0, "Description"],
              [Number(form.salePrice) > 0, "Sale price"],
              [images.length >= MIN_IMAGES, `At least ${MIN_IMAGES} images`],
              [video.length > 0, "Video"],
            ].map(([ok, label]) => (
              <li key={String(label)} className="flex items-center gap-2">
                <CheckCircle2
                  size={13}
                  className={ok ? "text-emerald-500" : "text-muted-foreground/40"}
                />
                <span className={ok ? "text-foreground" : undefined}>{label as string}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.div>
    </div>
  );
}
