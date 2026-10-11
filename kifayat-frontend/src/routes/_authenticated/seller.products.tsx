import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Package, Plus, Edit, Trash2, ArrowLeft, Eye, EyeOff, Layers } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  SellerProductForm,
  draftToPayload,
  emptyDraft,
  toDraft,
  type SellerProductDraft,
} from "@/components/seller/ProductForm";
import {
  fetchSellerProducts,
  createSellerProduct,
  updateSellerProduct,
  deleteSellerProduct,
} from "@/lib/seller-analytics.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/seller/products")({
  component: SellerProducts,
});

const firstImage = (product: any): string => {
  const gallery = Array.isArray(product?.gallery) ? product.gallery : [];
  const fromGallery = gallery.find((g: any) => g?.type !== "video" && g?.url)?.url;
  if (fromGallery) return String(fromGallery).split("?")[0];
  const list = String(product?.imageUrl ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (list[0] ?? "").split("?")[0];
};

function SellerProducts() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SellerProductDraft>(emptyDraft);

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["seller-products"],
    queryFn: fetchSellerProducts,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["seller-products"] });

  const createMutation = useMutation({
    mutationFn: createSellerProduct,
    onSuccess: (res: any) => {
      invalidate();
      toast.success(res?.message || "Product created.");
      setDialog(null);
    },
    onError: (e: Error) => toast.error(e.message || "Failed to create product"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: any }) =>
      updateSellerProduct(id, payload),
    onSuccess: (res: any) => {
      invalidate();
      toast.success(res?.message || "Product updated.");
      setDialog(null);
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update product"),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSellerProduct,
    onSuccess: (res: any) => {
      invalidate();
      toast.success(res?.message || "Product deleted.");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to delete product"),
  });

  const openCreate = () => {
    setDraft(emptyDraft());
    setEditingId(null);
    setDialog("create");
  };

  const openEdit = (product: any) => {
    setDraft(toDraft(product));
    setEditingId(product._id);
    setDialog("edit");
  };

  const submit = () => {
    const payload = draftToPayload(draft);
    if (!payload.name) {
      toast.error("Product name is required.");
      return;
    }
    if (!payload.category) {
      toast.error("Pick or create a category.");
      return;
    }
    if (dialog === "edit" && editingId) {
      updateMutation.mutate({ id: editingId, payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const pending = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="min-h-screen bg-bone">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate({ to: "/seller" })}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold text-coal">My Products</h1>
              <p className="text-coal/60 mt-1">
                {products.length} product{products.length === 1 ? "" : "s"} in your store
              </p>
            </div>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            Add Product
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Product list</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-12">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brass mx-auto" />
                <p className="mt-4 text-coal/60">Loading products…</p>
              </div>
            ) : products.length === 0 ? (
              <div className="text-center py-12">
                <Package className="h-16 w-16 text-coal/30 mx-auto mb-4" />
                <h2 className="text-xl font-semibold text-coal mb-2">No products yet</h2>
                <p className="text-coal/60 mb-4">
                  Add your first product with photos, pricing, stock and options.
                </p>
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Your First Product
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Wholesale</TableHead>
                      <TableHead className="text-right">Retail</TableHead>
                      <TableHead className="text-right">Stock</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((product: any) => {
                      const img = firstImage(product);
                      const options = Array.isArray(product.variations) ? product.variations.length : 0;
                      return (
                        <TableRow key={product._id}>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-3 min-w-0">
                              {img ? (
                                <img
                                  src={img}
                                  alt=""
                                  loading="lazy"
                                  className="size-11 shrink-0 rounded-md object-cover bg-bone"
                                />
                              ) : (
                                <div className="size-11 shrink-0 rounded-md bg-bone grid place-items-center">
                                  <Package className="h-4 w-4 text-coal/25" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <p className="truncate max-w-[280px]">{product.name}</p>
                                <p className="text-[11px] text-coal/45">
                                  {product.sku ? `SKU ${product.sku}` : product.slug}
                                </p>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{product.category}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            Rs {(product.costPrice ?? 0).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">
                            Rs {(product.salePrice ?? 0).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {product.stock}
                            {options > 0 && (
                              <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-coal/45">
                                <Layers className="h-3 w-3" />
                                {options}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {product.deleted ? (
                              <span className="text-[11px] text-red-600">Deleted</span>
                            ) : product.hidden ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-coal/50">
                                <EyeOff className="h-3 w-3" /> Hidden
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
                                <Eye className="h-3 w-3" /> Live
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                title="View on storefront"
                                onClick={() =>
                                  window.open(
                                    `/products/${product.slug || product._id}`,
                                    "_blank",
                                  )
                                }
                              >
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Edit product"
                                onClick={() => openEdit(product)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Delete product"
                                disabled={deleteMutation.isPending}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Remove "${product.name}" from your store? It can be restored by support.`,
                                    )
                                  ) {
                                    deleteMutation.mutate(product._id);
                                  }
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog
          open={dialog !== null}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        >
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{dialog === "edit" ? "Edit product" : "Add new product"}</DialogTitle>
              <DialogDescription>
                Fill in the same details as the rest of the catalogue — photos, pricing, stock,
                options and SEO.
              </DialogDescription>
            </DialogHeader>
            <SellerProductForm
              draft={draft}
              onChange={setDraft}
              pending={pending}
              submitLabel={dialog === "edit" ? "Save changes" : "Publish product"}
              onSubmit={submit}
              onCancel={() => setDialog(null)}
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
