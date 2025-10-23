// middleware/roles.js
function requireRole(role) {
  return (req, res, next) => {
    try {
      if (!req.user || !req.user.role) return res.status(403).json({ error: "Forbidden" });
      if (req.user.role !== role) return res.status(403).json({ error: "Admins only" });
      next();
    } catch (e) {
      return res.status(403).json({ error: "Forbidden" });
    }
  };
}
module.exports = { requireRole };
