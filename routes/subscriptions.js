// routes/subscriptions.js
const express = require("express");
const router = express.Router();
const { Pool } = require("pg");

// Fallback pool (only used if req.app.get('pool') is missing)
let fallbackPool = null;
function getPool(req) {
  const appPool = req.app && req.app.get && req.app.get("pool");
  if (appPool) return appPool;
  if (!fallbackPool) {
    fallbackPool = new Pool({ connectionString: process.env.DATABASE_URL });
    console.warn("[subscriptions] Using fallback pg Pool (app pool not set).");
  }
  return fallbackPool;
}

// GET /api/subscriptions/plans
router.get("/plans", async (req, res) => {
  try {
    const pool = getPool(req);

    // Your DB has a legacy shape; this normalizes to the API we want.
    // If the new columns (code, price_cents, currency, is_active) exist, use them.
    // Otherwise, compute from legacy columns.
    const hasCols = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='subscription_plans'
    `);

    const cols = new Set(hasCols.rows.map(r => r.column_name));
    const selectSQL = cols.has("code")
      ? `
        SELECT
          code,
          name,
          price_cents,
          currency,
          COALESCE(features::jsonb, '[]'::jsonb) AS features,
          COALESCE(is_active, TRUE)              AS is_active
        FROM public.subscription_plans
        ORDER BY price_cents NULLS LAST, name
      `
      : `
        SELECT
          -- Synthesize a code from the row (fallback)
          CONCAT('LEGACY_', id::text) AS code,
          name,
          -- Compute price_cents if you have legacy price_amount (numeric)
          COALESCE( (price_amount * 100)::int, 0 ) AS price_cents,
          COALESCE(price_currency, 'USD')         AS currency,
          -- Legacy "features" is text; present an empty array if not JSON
          '[]'::jsonb                              AS features,
          TRUE                                     AS is_active
        FROM public.subscription_plans
        ORDER BY (price_amount IS NULL) ASC, price_amount, name
      `;

    const out = await pool.query(selectSQL);
    res.json({ plans: out.rows });
  } catch (err) {
    console.error("subscriptions.plans error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/subscriptions/diag/columns
router.get("/diag/columns", async (req, res) => {
  try {
    const pool = getPool(req);
    const r = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='subscription_plans'
      ORDER BY ordinal_position
    `);
    res.json({ table: "public.subscription_plans", columns: r.rows });
  } catch (err) {
    res.status(500).json({
      error: "Server error",
      detail: process.env.DEBUG_MODE === "1" ? err.message : undefined,
      path: "/api/subscriptions/diag/columns"
    });
  }
});

module.exports = router;
