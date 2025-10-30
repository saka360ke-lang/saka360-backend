// routes/subscriptions.js
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { requireActiveSubscription } = require("../middleware/subscription");

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool");

  // List available plans
  router.get("/plans", async (_req, res) => {
    try {
      const q = await pool.query(
        `SELECT id, code, name, price_usd, vehicles_max, features
           FROM plan_catalog
          WHERE active = TRUE
          ORDER BY price_usd ASC`
      );
      res.json({ plans: q.rows });
    } catch (err) {
      console.error("plans list error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // My current subscription
  router.get("/me", authenticateToken, async (req, res) => {
    try {
      const q = await pool.query(
        `SELECT us.id, pc.code, pc.name, pc.price_usd, pc.vehicles_max, pc.features,
                us.status, us.period_start, us.period_end
           FROM user_subscriptions us
           JOIN plan_catalog pc ON pc.id = us.plan_id
          WHERE us.user_id = $1
          ORDER BY us.created_at DESC
          LIMIT 1`,
        [req.user.id]
      );
      res.json({ subscription: q.rows[0] || null });
    } catch (err) {
      console.error("sub me error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Subscribe (manual record — payments can update this later)
  router.post("/subscribe", authenticateToken, async (req, res) => {
    try {
      const { plan_code } = req.body || {};
      if (!plan_code) return res.status(400).json({ error: "plan_code required" });

      const p = await pool.query(`SELECT id FROM plan_catalog WHERE code=$1 AND active=TRUE`, [plan_code]);
      if (p.rows.length === 0) return res.status(404).json({ error: "Plan not found" });

      await pool.query(
        `INSERT INTO user_subscriptions(user_id, plan_id, status)
         VALUES ($1,$2,'active')`,
        [req.user.id, p.rows[0].id]
      );

      res.json({ ok: true, message: "Subscribed ✅" });
    } catch (err) {
      console.error("subscribe error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Example feature-gated endpoint
  router.get("/feature/reports", authenticateToken, requireActiveSubscription(), async (req, res) => {
    const canPdf = !!req.subscription?.features?.reports_pdf;
    res.json({ plan: req.subscription?.plan_code, reports_pdf: canPdf });
  });

  app.use("/api/subscriptions", router);
};
