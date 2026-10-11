import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useRef, useCallback } from "react";
import {
  X, Upload, Image as ImageIcon, Video, Package, AlertTriangle, Mail, Phone, CheckCircle2,
} from "lucide-react";
import { submitDefectiveReport, getDefectiveContact } from "@/lib/defective.api";
import { ProductSearch } from "@/components/defective/ProductSearch";
import type { UIProduct } from "@/lib/api";
import { optImage } from "@/lib/product-image-map";

export const Route = createFileRoute("/account/defect-reports")({
  component: AccountDefectReports,
});

const REQUIRED_PHOTOS = 2;
const REQUIRED_VIDEOS = 1;

function AccountDefectReports() {
  const [selectedProduct, setSelectedProduct] = useState<UIProduct | null>(null);
  const [description, setDescription] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [videos, setVideos] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const imageRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  // Email + phone come from the account (falling back to the shipping details
  // on past orders) — the customer never retypes them.
  const { data: contact, isLoading: contactLoading } = useQuery({
    queryKey: ["defective-contact"],
    queryFn: getDefectiveContact,
  });

  const handleImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setImages((prev) => [...prev, ...files].slice(0, REQUIRED_PHOTOS));
    e.target.value = "";
  }, []);

  const handleVideoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setVideos((prev) => [...prev, ...files].slice(0, REQUIRED_VIDEOS));
    e.target.value = "";
  }, []);

  const removeImage = (i: number) => setImages((prev) => prev.filter((_, idx) => idx !== i));
  const removeVideo = (i: number) => setVideos((prev) => prev.filter((_, idx) => idx !== i));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) { setError("Please describe the defect."); return; }
    if (images.length < REQUIRED_PHOTOS) { setError(`Please add ${REQUIRED_PHOTOS} photos of the product (${images.length} added).`); return; }
    if (videos.length < REQUIRED_VIDEOS) { setError("Please add 1 video covering the complete unboxing of the product, otherwise the request will not be entertained. Thanks — Kifayat"); return; }
    setError("");
    setSubmitting(true);
    try {
      const fd = new FormData();
      if (selectedProduct) fd.append("productId", selectedProduct.id);
      fd.append("description", description.trim());
      images.forEach((f) => fd.append("images", f));
      videos.forEach((f) => fd.append("videos", f));
      await submitDefectiveReport(fd);
      setSuccess(true);
      setSelectedProduct(null);
      setDescription("");
      setImages([]);
      setVideos([]);
    } catch (err: any) {
      setError(err.message || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow text-muted-foreground flex items-center gap-2">
          <span className="w-3 h-px bg-brass"></span> Quality assurance
        </p>
        <h2 className="font-display italic text-3xl lg:text-4xl mt-1 tracking-tight">
          Report a Defective Product<span className="text-brass">.</span>
        </h2>
        <p className="text-sm text-muted-foreground mt-2">
          Received a faulty item? Tell us what went wrong — we'll review it within 24&ndash;48 hours.
        </p>
      </div>

      {success ? (
        <div className="bg-card border border-border rounded-2xl p-12 text-center space-y-4">
          <div className="size-14 bg-green-500/10 rounded-full grid place-items-center mx-auto">
            <CheckCircle2 className="size-7 text-green-600" strokeWidth={1.5} />
          </div>
          <h3 className="text-lg font-semibold">Report submitted</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Thanks for letting us know. Our team will review your report and get back to you within 24&ndash;48 hours.
          </p>
          <button
            onClick={() => setSuccess(false)}
            className="mt-2 h-10 px-6 bg-foreground text-background rounded-xl text-sm font-semibold hover:opacity-90 transition"
          >
            Report another product
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="bg-card border border-border rounded-2xl p-6 sm:p-8 space-y-6">
          {error && (
            <div className="bg-red-500/10 border border-red-500/25 text-red-600 text-sm rounded-xl px-4 py-3">
              {error}
            </div>
          )}

          {/* Contact details — supplied automatically from the account */}
          <div className="rounded-xl border border-border bg-secondary/40 p-4 space-y-3">
            <p className="text-[10px] uppercase tracking-[0.2em] font-semibold text-muted-foreground">
              We'll contact you at
            </p>
            <div className="grid sm:grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2.5">
                <Mail className="size-4 text-brass shrink-0" strokeWidth={1.8} />
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Email</p>
                  <p className="font-medium truncate">
                    {contactLoading ? "Loading…" : contact?.email || "Not on file"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <Phone className="size-4 text-brass shrink-0" strokeWidth={1.8} />
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Phone</p>
                  <p className="font-medium truncate">
                    {contactLoading ? "Loading…" : contact?.phone || "Not on file"}
                  </p>
                </div>
              </div>
            </div>
            {!contactLoading && !contact?.phone && (
              <p className="text-[11px] text-muted-foreground">
                No phone number on your account or past orders. Add one in your{" "}
                <span className="font-semibold text-foreground">Profile</span> so we can reach you faster.
              </p>
            )}
          </div>

          <ProductSearch onSelect={setSelectedProduct} />

          {selectedProduct && (
            <div className="flex items-center gap-3 bg-secondary/50 rounded-xl px-3.5 py-2.5 border border-border">
              {selectedProduct.image_url ? (
                <img src={optImage(selectedProduct.image_url, 80)} alt="" className="size-10 rounded object-cover shrink-0" />
              ) : (
                <Package className="size-10 rounded object-cover shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{selectedProduct.name}</p>
                <p className="text-xs text-muted-foreground">Rs. {selectedProduct.price?.toLocaleString()}</p>
              </div>
              <button type="button" onClick={() => setSelectedProduct(null)} className="size-6 grid place-items-center hover:bg-border rounded shrink-0">
                <X className="size-3.5" />
              </button>
            </div>
          )}

          <label className="block">
            <span className="block text-sm font-medium mb-1.5">Describe the defect <span className="text-red-500">*</span></span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              required
              placeholder="What went wrong? Please describe the defect in detail..."
              className="w-full px-3.5 py-2.5 rounded-xl border border-border bg-secondary/50 outline-none focus:border-brass text-sm resize-none"
            />
          </label>

          <div className="grid sm:grid-cols-2 gap-4">
            {/* Photos — exactly 2 */}
            <div>
              <span className="block text-sm font-medium mb-1.5">
                Photos <span className="text-red-500">*</span>{" "}
                <span className="text-muted-foreground font-normal">({images.length}/{REQUIRED_PHOTOS})</span>
              </span>
              <input
                ref={imageRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                onChange={handleImageChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => imageRef.current?.click()}
                disabled={images.length >= REQUIRED_PHOTOS}
                className="w-full h-24 border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-brass hover:text-brass transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-muted-foreground"
              >
                <ImageIcon className="size-6" strokeWidth={1.5} />
                <span className="text-xs">Add {REQUIRED_PHOTOS} photos</span>
              </button>
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {images.map((f, i) => (
                    <div key={i} className="relative group size-16 rounded-xl overflow-hidden border border-border shrink-0">
                      <img src={URL.createObjectURL(f)} alt="" className="size-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute top-1 right-1 size-5 bg-black/60 rounded-full grid place-items-center opacity-0 group-hover:opacity-100 transition"
                      >
                        <X className="size-3 text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Video — exactly 1 */}
            <div>
              <span className="block text-sm font-medium mb-1.5">
                Video <span className="text-red-500">*</span>{" "}
                <span className="text-muted-foreground font-normal">({videos.length}/{REQUIRED_VIDEOS})</span>
              </span>
              <p className="text-[10px] text-muted-foreground mb-2 leading-relaxed">
                Video should cover the complete unboxing of the product, otherwise the request will not be
                entertained. Thanks — Kifayat
              </p>
              <input
                ref={videoRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                onChange={handleVideoChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => videoRef.current?.click()}
                disabled={videos.length >= REQUIRED_VIDEOS}
                className="w-full h-24 border-2 border-dashed border-border rounded-xl flex flex-col items-center justify-center gap-1 text-muted-foreground hover:border-brass hover:text-brass transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:text-muted-foreground"
              >
                <Video className="size-6" strokeWidth={1.5} />
                <span className="text-xs">Add 1 video</span>
              </button>
              {videos.length > 0 && (
                <div className="space-y-1.5 mt-2">
                  {videos.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 bg-secondary/50 rounded-lg px-2.5 py-1.5 text-xs">
                      <Video className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">{f.name}</span>
                      <button type="button" onClick={() => removeVideo(i)} className="size-4 grid place-items-center hover:bg-border rounded shrink-0">
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-12 bg-foreground text-background rounded-xl text-sm font-bold hover:opacity-90 transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>Submitting&hellip;</>
            ) : (
              <><Upload className="size-4" strokeWidth={1.5} /> Submit report</>
            )}
          </button>
        </form>
      )}
    </div>
  );
}
