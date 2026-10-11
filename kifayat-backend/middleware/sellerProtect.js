const requireSeller = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required. Please log in.",
    });
  }

  if (req.user.role !== "seller" && req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Seller privileges required.",
    });
  }

  next();
};

module.exports = { requireSeller };
