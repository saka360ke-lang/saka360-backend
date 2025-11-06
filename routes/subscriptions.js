// routes/subscriptions.js
const express = require("express");
const router = express.Router();

function getPool(req) {
  return req.app.get("pool");
}

function toCode(row) {
  // Prefer explicit codes if present; else derive a stable code
  if (row.code) return row.code;
  if (row.plan_code) return row.plan_code;
  if (row.slug) return String(row.slug).toUpperCase();
  if (row.name) return String(row.name).toUpperCase().replace(/\s+/g, "_");
  return `PLAN_${row.id || "UNKNOWN"}`;
}

function toFeatures(row, cols) {
  if (cols.has("features_json") && row.features_json) return row.features_json;
  if (cols.has("features") && row.features) {
    // could be json or text
    try {
      const parsed = typeof row.features === "string" ? JSON.parse(row.features) : row.features;
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      /* fallthrough */
    }
    // fallback: comma-separated string -> array
    if (typeof row.features === "string") {
      return row.features.split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function toPriceCents(row, cols) {
  if (cols.has("price_cents") && row.price_cents != null) return Number(row.price_cents);
  if (cols.has("price_amount") && row.price_amount != null) {
    const n = Number(row.price_amount);
    if (!Number.isNaN(n)) return Math.round(n * 100);
  }
  return 0;
}

function toCurrency(row, cols) {
  return row.currency || row.price_currency || "USD";
}

router.get("/plans", async (req, res) => {
  try {
    const pool = getPool(req);
    if (!pool) return res.status(500).json({ error: "DB not attached" });

    // detect columns
    const colQ = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='subscription_plans'`
    );
    const cols = new Set(colQ.rows.map(r => r.column_name));

    // load rows (generic)
    const rowsQ = await pool.query(
      `SELECT * FROM public.subscription_plans`
    );

    // normalize
    const normalized = rowsQ.rows.map(r => ({
      code: toCode(r),
      name: r.name || "Plan",
      price_cents: toPriceCents(r, cols),
      currency: toCurrency(r, cols),
      is_active: (cols.has("is_active") ? !!r.is_active : true),
      features: toFeatures(r, cols),
      paystack_plan_code: cols.has("paystack_plan_code") ? (r.paystack_plan_code || null) : null,
      sort: (cols.has("sort_order") ? (r.sort_order || 0) : (toPriceCents(r, cols) || 0))
    }));

    // sort by price or sort_order
    normalized.sort((a, b) => a.sort - b.sort);

    // drop helper property
    normalized.forEach(p => delete p.sort);

    res.json({ plans: normalized });
  } catch (e) {
    console.error("subscriptions.plans error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
