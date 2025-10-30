// routes/subscriptions.js
const express = require("express");
const router = express.Router();

/**
 * GET /api/subscriptions/plans
 * Returns active plans from public.subscription_plans
 */
router.get("/plans", async (req, res) => {
  const pool = req.app.get("pool");
  if (!pool) {
    return res
      .status(500)
      .json({ error: "Server error", detail: "Pool not found on app; set app.set('pool', pool) in index.js" });
  }

  try {
    const q = await pool.query(
      `SELECT code, name, price_cents, currency, features, is_active
         FROM public.subscription_plans
        WHERE is_active = TRUE
        ORDER BY price_cents ASC`
    );
    return res.json({ plans: q.rows });
  } catch (e) {
    console.error("subscriptions.plans error:", e);
    return res
      .status(500)
      .json({ error: "Server error", detail: process.env.DEBUG_MODE === "1" ? e.message : undefined });
  }
});

/**
 * GET /api/subscriptions/me
 * Return the current user's subscription (if any)
 * Requires Authorization: Bearer <token> (so we know req.user.id)
 */
router.get("/me", async (req, res) => {
  const pool = req.app.get("pool");
  if (!pool) return res.status(500).json({ error: "Server error", detail: "Pool not found" });

  try {
    // Optional: if you already have auth middleware, you can use it here.
    // For now, accept ?user_id= for testing in Postman.
    const userId = Number(req.user?.id || req.query.user_id);
    if (!userId) return res.status(400).json({ error: "Missing user_id (or login token)" });

    const q = await pool.query(
      `SELECT us.id, us.user_id, us.plan_code, us.status, us.started_at, us.renewed_at, us.meta,
              sp.name, sp.price_cents, sp.currency, sp.features
         FROM public.user_subscriptions us
         JOIN public.subscription_plans sp
           ON sp.code = us.plan_code
        WHERE us.user_id = $1
        ORDER BY us.started_at DESC
        LIMIT 1`,
      [userId]
    );

    return res.json({ subscription: q.rows[0] || null });
  } catch (e) {
    console.error("subscriptions.me error:", e);
    return res.status(500).json({ error: "Server error", detail: process.env.DEBUG_MODE === "1" ? e.message : undefined });
  }
});

/**
 * POST /api/subscriptions/subscribe
 * Body: { user_id, plan_code }
 * Creates (or updates) a subscription record for a user.
 * NOTE: In production you’ll gate this behind payments.
 */
router.post("/subscribe", async (req, res) => {
  const pool = req.app.get("pool");
  if (!pool) return res.status(500).json({ error: "Server error", detail: "Pool not found" });

  try {
    const { user_id, plan_code } = req.body || {};
    if (!user_id || !plan_code) {
      return res.status(400).json({ error: "user_id and plan_code are required" });
    }

    // Ensure plan exists
    const plan = await pool.query(
      `SELECT code FROM public.subscription_plans WHERE code=$1 AND is_active=TRUE`,
      [plan_code]
    );
    if (plan.rows.length === 0) {
      return res.status(400).json({ error: "Invalid plan_code" });
    }

    // Upsert a simple current sub. In future, you may want a historical table or statuses.
    const up = await pool.query(
      `INSERT INTO public.user_subscriptions (user_id, plan_code, status, started_at, meta)
       VALUES ($1, $2, 'active', NOW(), '{}'::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [user_id, plan_code]
    );

    // If already had one, return latest
    let sub = up.rows[0];
    if (!sub) {
      const q = await pool.query(
        `SELECT * FROM public.user_subscriptions
          WHERE user_id=$1
          ORDER BY started_at DESC
          LIMIT 1`,
        [user_id]
      );
      sub = q.rows[0] || null;
    }

    return res.json({ ok: true, subscription: sub });
  } catch (e) {
    console.error("subscriptions.subscribe error:", e);
    return res.status(500).json({ error: "Server error", detail: process.env.DEBUG_MODE === "1" ? e.message : undefined });
  }
});

/**
 * (Optional) Quick diag – checks plan table is readable
 * GET /api/subscriptions/_diag
 */
router.get("/_diag", async (req, res) => {
  const pool = req.app.get("pool");
  if (!pool) return res.status(500).json({ error: "Server error", detail: "Pool not found" });
  try {
    const q = await pool.query(
      `SELECT COUNT(*)::int AS count FROM public.subscription_plans`
    );
    res.json({ ok: true, plans_count: q.rows[0]?.count ?? 0 });
  } catch (e) {
    console.error("subscriptions._diag error:", e);
    res.status(500).json({ ok: false, error: "Server error", detail: process.env.DEBUG_MODE === "1" ? e.message : undefined });
  }
});

module.exports = router;
