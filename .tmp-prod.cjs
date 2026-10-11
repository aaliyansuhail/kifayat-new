const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "kifayat-frontend", "src", "routes", "_authenticated", "admin.products.tsx");
let s = fs.readFileSync(p, "utf8");
const fails = [];
const rep = (a, b, label) => {
  if (!s.includes(a)) { fails.push(label); return; }
  s = s.split(a).join(b);
};

rep(`  adminUploadProductCSV,
  adminClearProducts,
  adminGetCategoryPricing,
  adminUpdatePricingAll,
  adminUpdatePricingByCategory,
  adminUpdateProduct,
  adminGetProductOrders,
  adminDownloadCSV,
  adminGetCSVQueueCount,
  adminToggleFeaturedOnLanding,
  adminGetFeaturedCount,
  adminFetchProductDynamicData,
  adminUpdateProductManualPosition,
  adminUpdateBulkManualPositions,
  adminClearAllManualPositions,
} from "@/lib/admin.functions";
import { Trash, ExternalLink, Upload, Eye, EyeOff, Edit2, Package, Inbox, Loader2, X, Download, Save, Box, Percent, TrendingUp, ChevronDown, CheckCircle, RefreshCw, Search, ChevronLeft, ChevronRight, Target, Database, ArrowUpDown } from "lucide-react";`,
`  adminClearProducts,
  adminUpdateProduct,
  adminGetProductOrders,
  adminToggleFeaturedOnLanding,
  adminGetFeaturedCount,
  adminUpdateProductManualPosition,
  adminUpdateBulkManualPositions,
  adminClearAllManualPositions,
} from "@/lib/admin.functions";
import { Trash, ExternalLink, Eye, EyeOff, Edit2, Package, Inbox, Loader2, X, Save, Box, ChevronDown, Search, ChevronLeft, ChevronRight, Target, ArrowUpDown } from "lucide-react";`,
"imports");

rep(`  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [globalPct, setGlobalPct] = useState("");
  const [catPct, setCatPct] = useState("");
  const [selectedCat, setSelectedCat] = useState("");
  const [activeSection, setActiveSection] = useState<"csv" | "pricing" | null>(null);
  const [editingProduct, setEditingProduct] = useState<any | null>(null);
  const [ordersProduct, setOrdersProduct] = useState<any | null>(null);
  const [csvDownloading, setCsvDownloading] = useState(false);
`,
`  const [editingProduct, setEditingProduct] = useState<any | null>(null);
  const [ordersProduct, setOrdersProduct] = useState<any | null>(null);
`,
"state");

rep(`  // CSV queue count — to enable/disable the download button
  const { data: csvQueueCount = 0 } = useQuery({
    queryKey: ["admin", "products-csv-queue"],
    queryFn: adminGetCSVQueueCount,
    refetchInterval: 60_000,
  });

  const { data: catPricingData } = useQuery({
    queryKey: ["admin", "category-pricing"],
    queryFn: adminGetCategoryPricing,
  });

  const { data: featuredCount = 0 } = useQuery({
    queryKey: ["admin", "featured-count"],
    queryFn: adminGetFeaturedCount,
  });

  // Seed the global % input from the saved value once data arrives
  useEffect(() => {
    const saved = catPricingData?.globalPricing;
    if (saved != null && globalPct === "") {
      setGlobalPct(String(saved));
    }
  }, [catPricingData?.globalPricing]);

  const categories: string[] = (catPricingData?.categories ?? []).map((c: any) => c.name ?? c);
`,
`  const { data: featuredCount = 0 } = useQuery({
    queryKey: ["admin", "featured-count"],
    queryFn: adminGetFeaturedCount,
  });

  const { data: categoriesData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => api.get<{ success: boolean; categories: { name: string }[] }>("/products/categories"),
  });
  const categories: string[] = (categoriesData?.categories ?? []).map((c) => c.name);
`,
"queries");

const startA = s.indexOf("  const globalPricingMut = useMutation({");
const endA = s.indexOf("  const featuredMut = useMutation({");
if (startA >= 0 && endA > startA) s = s.slice(0, startA) + s.slice(endA); else fails.push("pricing mutations");

const startB = s.indexOf("  const [dynFetchingId, setDynFetchingId] = useState<string | null>(null);");
const endB = s.indexOf("  const deleteProductMut = useMutation({");
if (startB >= 0 && endB > startB) s = s.slice(0, startB) + s.slice(endB); else fails.push("dynamic mutation");

const startC = s.indexOf("  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {");
const endC = s.indexOf("  return (");
if (startC >= 0 && endC > startC) s = s.slice(0, startC) + s.slice(endC); else fails.push("handlers");

const startD = s.indexOf("          <button\n            onClick={handleDownloadCSV}");
const endD = s.indexOf("          <button\n            onClick={() => { if (window.confirm(\"Clear ALL products?");
if (startD >= 0 && endD > startD) {
  s = s.slice(0, startD) + `          <Link
            to="/admin/add-product"
            className="flex items-center justify-center gap-2 w-full sm:w-auto px-4 py-2.5 text-sm font-bold bg-coal text-bone rounded-xl hover:bg-coal/90 transition-all shadow-e1"
          >
            <Target className="size-4" /> Add Product
          </Link>
` + s.slice(endD);
} else fails.push("header buttons");

const startE = s.indexOf("      {/* ── Global Profit Margin card");
const endE = s.indexOf("      {/* ── Product Hunting card");
if (startE >= 0 && endE > startE) s = s.slice(0, startE) + s.slice(endE); else fails.push("margin card");

const startF = s.indexOf("      <AnimatePresence mode=\"wait\">");
const endF = s.indexOf("      {/* Search bar */}");
if (startF >= 0 && endF > startF) s = s.slice(0, startF) + s.slice(endF); else fails.push("panels");

const beforeDyn = s.length;
s = s.replace(/\n\s*\{p\.dynamicDataFetched && \(\s*<span[\s\S]*?<\/span>\s*\)\}/g, "");
s = s.replace(/\n\s*<button\s+onClick=\{\(\) => dynDataMut\.mutate\(pid\)\}[\s\S]*?<\/button>/g, "");
if (s.length === beforeDyn) fails.push("dynamic ui");

rep("Set custom positions for products · Positions persist until HHC sync", "Set custom positions for products · Positions persist until you change them", "positions copy");
rep('{debouncedSearch ? "Try a different search term." : "Upload a CSV to populate your catalogue."}', '{debouncedSearch ? "Try a different search term." : "Add your first product to populate the catalogue."}', "empty copy");

fs.writeFileSync(p, s);
console.log("fails:", fails.length ? fails.join(" | ") : "none");
console.log("lines:", s.split("\n").length);
