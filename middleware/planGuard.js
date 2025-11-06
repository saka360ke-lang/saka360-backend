// middleware/planGuard.js
/**
 * Enforce plan limits. You can use this before handlers that create vehicles,
 * upload documents, generate reports, etc.
 *
 * Example use:
 *   const { planGuard } = require("../middleware/planGuard");
 *   router.post("/vehicles", authenticateToken, planGuard({ maxVehicles: 3 }), handler)
 */

async function getUserPlan(pool, userId) {
  // Joins to get currency/price/features if you want; for now, only plan_code
  const r = await pool.query(
    `SELECT us.plan_code
       FROM public.user_subscriptions us
      WHERE us.user_id=$1 AND us.status='active'
      ORDER BY us.renewed_at DESC
      LIMIT 1`,
    [userId]
  );
  return r.rows[0]?.plan_code || 'FREE';
}

function rulesFor(planCode) {
  // Simple table; tune later if you like
  switch (planCode) {
    case "FLEET_PRO": return { maxVehicles: 9999, docsEnabled: true, whatsappReminders: true };
    case "PREMIUM" :  return { maxVehicles: 10,   docsEnabled: true,  whatsappReminders: true };
    case "BASIC"   :  return { maxVehicles: 3,    docsEnabled: true,  whatsappReminders: true };
    default        :  return { maxVehicles: 1,    docsEnabled: false, whatsappReminders: false }; // FREE
  }
}

function planGuard(opts = {}) {
  // opts can override defaults, e.g., { maxVehicles: 3 } for a vehicles-create route
  return async (req, res, next) => {
    try {
      const pool = req.app.get("pool");
      const userId = req.user?.id;
      if (!pool || !userId) return res.status(401).json({ error: "Unauthorized" });

      const planCode = await getUserPlan(pool, userId);
      const r = { ...rulesFor(planCode), ...opts };

      // Example enforcement:
      if (typeof r.maxVehicles === "number" && r.maxVehicles >= 0 && req.enforceMaxVehicles) {
        const q = await pool.query(`SELECT COUNT(*)::int AS c FROM public.vehicles WHERE user_id=$1`, [userId]);
        const count = q.rows[0]?.c || 0;
        if (count >= r.maxVehicles) {
          return res.status(403).json({ error: `Vehicle limit reached for your ${planCode} plan` });
        }
      }

      if (req.enforceDocs && !r.docsEnabled) {
        return res.status(403).json({ error: `Document storage is not available on your ${planCode} plan` });
      }

      // Attach computed plan to request (use later if needed)
      req.userPlan = { code: planCode, ...r };
      next();
    } catch (e) {
      console.error("planGuard error:", e);
      res.status(500).json({ error: "Plan enforcement failed", detail: e.message });
    }
  };
}

module.exports = { planGuard };
