// middleware/subscription.js
module.exports.requireActiveSubscription = () => {
  return async (req, res, next) => {
    try {
      const pool = req.app.get("pool");
      if (!pool) return res.status(500).json({ error: "Pool not configured" });
      if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });

      // active sub?
      const q = await pool.query(
        `SELECT us.id, pc.code, pc.vehicles_max, pc.features
           FROM user_subscriptions us
           JOIN plan_catalog pc ON pc.id = us.plan_id
          WHERE us.user_id = $1
            AND us.status = 'active'
            AND (us.period_end IS NULL OR us.period_end >= CURRENT_DATE)
          ORDER BY us.created_at DESC
          LIMIT 1`,
        [req.user.id]
      );

      if (q.rows.length === 0) {
        return res.status(402).json({ error: "Subscription required" });
      }

      req.subscription = {
        plan_code: q.rows[0].code,
        vehicles_max: q.rows[0].vehicles_max,
        features: q.rows[0].features || {}
      };

      next();
    } catch (err) {
      console.error("requireActiveSubscription error:", err);
      res.status(500).json({ error: "Server error" });
    }
  };
};
