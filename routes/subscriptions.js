// routes/subscriptions.js
const express = require("express");
const router = express.Router();

function getPool(req) {
  const pool = req.app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");
  return pool;
}

router.get("/plans", async (req, res) => {
  try {
    const pool = getPool(req);
    const sql = `
      SELECT
        COALESCE(NULLIF(TRIM(code), ''), UPPER(REGEXP_REPLACE(name,'[^A-Za-z0-9]','','g'))) AS code,
        name,
        COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents,
        COALESCE(currency, price_currency, 'KES') AS currency,
        COALESCE(is_active, TRUE) AS is_active,
        CASE
          WHEN jsonb_typeof(features_json) IS NOT NULL THEN features_json
          WHEN features IS NOT NULL THEN to_jsonb(string_to_array(features, ','))  -- legacy text list
          ELSE '[]'::jsonb
        END AS features,
        paystack_plan_code
      FROM subscription_plans
      ORDER BY
        CASE UPPER(COALESCE(code,'')) WHEN 'FREE' THEN 0 ELSE 1 END,
        price_cents ASC NULLS LAST
    `;
    const rows = (await pool.query(sql)).rows;

    const plans = rows.map(r => ({
      code: (r.code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      name: r.name,
      price_cents: r.price_cents || 0,
      currency: r.currency || "KES",
      is_active: !!r.is_active,
      features: Array.isArray(r.features) ? r.features : (r.features?.map?.(x => String(x)) || []),
      paystack_plan_code: r.paystack_plan_code || null
    }));

    res.json({ plans });
  } catch (e) {
    console.error("subscriptions.plans error:", e);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
