import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  ShoppingBag, Package, TrendingUp, Plus, Trash2, ArrowUpRight,
  MousePointerClick, Hand, Users,
} from "lucide-react";
import { useAuth } from "@/lib/auth-store";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { EngagementAnalytics } from "@/components/seller/EngagementAnalytics";
import {
  fetchSellerAnalytics,
  fetchSellerProducts,
} from "@/lib/seller-analytics.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/seller/")({
  component: SellerDashboard,
});

const EMPTY_ORDERS: never[] = [];

function SellerDashboard() {
  const { user } = useAuth();
  const [tab, setTab] = useState("overview");
  const canManage = user?.role === "seller" || user?.role === "admin";

  const { data: analyticsData, error: analyticsError } = useQuery({
    queryKey: ["seller-analytics"],
    queryFn: fetchSellerAnalytics,
    enabled: canManage,
  });

  const { data: sellerProducts } = useQuery({
    queryKey: ["seller-products"],
    queryFn: fetchSellerProducts,
    enabled: canManage,
  });

  useEffect(() => {
    if (analyticsError) toast.error(analyticsError.message || "Failed to fetch analytics");
  }, [analyticsError]);

  const engagement = analyticsData?.interactions?.last30Days;
  const products = sellerProducts ?? [];

  return (
    <div className="min-h-screen bg-bone">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-coal">Seller Dashboard</h1>
            <p className="text-coal/60 mt-2">Welcome back, {user?.name || "Seller"}</p>
          </div>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="engagement">Engagement</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {tab === "engagement" ? (
          <EngagementAnalytics />
        ) : (
        <>
        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Products</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{(analyticsData?.totalProducts ?? 0) || 0}</div>
              <p className="text-xs text-muted-foreground">Active in catalogue</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Sales</CardTitle>
              <ShoppingBag className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{(analyticsData?.totalSales ?? 0) || 0}</div>
              <p className="text-xs text-muted-foreground">Orders completed</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Revenue</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                Rs {Math.round((analyticsData?.totalRevenue ?? 0) || 0).toLocaleString()}
              </div>
              <p className="text-xs text-muted-foreground">All time earnings</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Items Sold</CardTitle>
              <ShoppingBag className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{(analyticsData?.totalItemsSold ?? 0) || 0}</div>
              <p className="text-xs text-muted-foreground">Total units sold</p>
            </CardContent>
          </Card>
        </div>

        {/* Engagement snapshot */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Customers (30d)</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">
                {engagement?.uniqueVisitors ?? 0}
              </div>
              <p className="text-xs text-muted-foreground">Unique visitors to your products</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Clicks (30d)</CardTitle>
              <MousePointerClick className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">
                {engagement?.clicks ?? 0}
              </div>
              <p className="text-xs text-muted-foreground">
                {engagement?.pageviews ?? 0} reached a product page
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Hovers (30d)</CardTitle>
              <Hand className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold tabular-nums">
                {engagement?.hovers ?? 0}
              </div>
              <p className="text-xs text-muted-foreground">Pointer interest before clicking</p>
            </CardContent>
          </Card>
        </div>

        {/* Products Section */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>My Products</CardTitle>
              <Link to="/seller/products">
                <Button>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Product
                </Button>
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            {products.length === 0 ? (
              <div className="text-center py-8">
                <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground mb-4">No products yet. Add your first product!</p>
                <Link to="/seller/products">
                  <Button>
                    <Plus className="h-4 w-4 mr-2" />
                    Add Your First Product
                  </Button>
                </Link>
              </div>
            ) : (
              <div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>Price</TableHead>
                      <TableHead>Stock</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.slice(0, 5).map((product: any) => (
                      <TableRow key={product._id}>
                        <TableCell className="font-medium">{product.name}</TableCell>
                        <TableCell>{product.category}</TableCell>
                        <TableCell>Rs {product.salePrice?.toLocaleString()}</TableCell>
                        <TableCell>{product.stock}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {products.length > 5 && (
                  <div className="mt-4 text-center">
                    <Link to="/seller/products">
                      <Button variant="outline">
                        View All {products.length} Products
                        <ArrowUpRight className="h-4 w-4 ml-2" />
                      </Button>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Orders */}
        {(analyticsData?.recentOrders ?? EMPTY_ORDERS) && (analyticsData?.recentOrders ?? EMPTY_ORDERS).length > 0 && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>Recent Orders</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order ID</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(analyticsData?.recentOrders ?? EMPTY_ORDERS).slice(0, 5).map((order: any) => (
                    <TableRow key={order._id}>
                      <TableCell className="font-medium">{order.orderId || order._id}</TableCell>
                      <TableCell>{new Date(order.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>{order.status}</TableCell>
                      <TableCell className="text-right">
                        Rs {Math.round(order.totalAmount || 0).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
        </>
        )}
      </div>
    </div>
  );
}
