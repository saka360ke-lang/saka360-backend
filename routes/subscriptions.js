// routes/subscriptions.js
const express = require("express");

/**
 * This file is FUNCTION-STYLE: export a function(app) and mount inside index.js with:
 *   require("./routes/subscriptions")(app);
 *
 * DO NOT also mount it as a router-style app.use("/api/subscriptions", ...) or you'll double-mount.
 */
module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");

  // Small helper: check if a column exists on a table
  async function columnsFor(table) {
    const sql = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
    `;
    const r = await pool.query(sql, [table]);
    const s = new Set(r.rows.map((x) => x.column_name));
    return s;
  }

  // GET /api/subscriptions/plans
  router.get("/subscriptions/plans", async (_req, res) => {
    try {
      const cols = await columnsFor("subscription_plans");

      const has = (c) => cols.has(c);

      // ---- Build safe expressions that do NOT reference missing columns ----
      // code
      const codeExpr = has("code")
        ? "code"
        : "regexp_replace(upper(name), '[^A-Z0-9]+', '_', 'g')";

      // name (should exist, but guard anyway)
      const nameExpr = has("name") ? "name" : "NULL::text AS name";

      // price_cents
      let priceCentsExpr = "0";
      if (has("price_cents") && has("price_amount")) {
        priceCentsExpr = "COALESCE(price_cents, (price_amount*100)::int, 0)";
      } else if (has("price_cents")) {
        priceCentsExpr = "COALESCE(price_cents, 0)";
      } else if (has("price_amount")) {
        priceCentsExpr = "(price_amount*100)::int";
      }

      // currency
      let currencyExpr = "'USD'";
      if (has("currency") && has("price_currency")) {
        currencyExpr = "COALESCE(currency, price_currency, 'USD')";
      } else if (has("currency")) {
        currencyExpr = "COALESCE(currency, 'USD')";
      } else if (has("price_currency")) {
        currencyExpr = "COALESCE(price_currency, 'USD')";
      }

      // is_active
      const isActiveExpr = has("is_active")
        ? "COALESCE(is_active, TRUE)"
        : "TRUE";

      // features JSON (prefer features_json if present, else derive from features text, else [])
      let featuresExpr = "'[]'::jsonb";
      if (has("features_json") && has("features")) {
        featuresExpr = `
          COALESCE(
            features_json,
            CASE
              WHEN features IS NULL THEN '[]'::jsonb
              WHEN features ~ '^\\s*\\[' THEN features::jsonb
              ELSE to_jsonb(string_to_array(features, ','))
            END
          )
        `;
      } else if (has("features_json")) {
        featuresExpr = "COALESCE(features_json, '[]'::jsonb)";
      } else if (has("features")) {
        featuresExpr = `
          CASE
            WHEN features IS NULL THEN '[]'::jsonb
            WHEN features ~ '^\\s*\\[' THEN features::jsonb
            ELSE to_jsonb(string_to_array(features, ','))
          END
        `;
      }

      // Build the SELECT using only safe expressions
      const sql = `
        SELECT
          ${codeExpr}            AS code,
          ${nameExpr}            AS name,
          ${priceCentsExpr}      AS price_cents,
          ${currencyExpr}        AS currency,
          ${featuresExpr}        AS features,
          ${isActiveExpr}        AS is_active
        FROM subscription_plans
        ORDER BY price_cents NULLS LAST, name
      `;

      const q = await pool.query(sql);
      // normalize features to array<string>
      const plans = q.rows.map((r) => ({
        code: r.code,
        name: r.name,
        price_cents: typeof r.price_cents === "number" ? r.price_cents : 0,
        currency: r.currency || "USD",
        features: Array.isArray(r.features) ? r.features : [],
        is_active: !!r.is_active,
      }));

      return res.json({ plans });
    } catch (err) {
      console.error("subscriptions.plans error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // Optionally expose a tiny diag endpoint to see which columns exist
  router.get("/subscriptions/diag/columns", async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='subscription_plans'
          ORDER BY column_name`
      );
      res.json({ table: "subscription_plans", columns: r.rows.map((x) => x.column_name) });
    } catch (e) {
      res.status(500).json({ error: "diag failed", detail: e.message });
    }
  });

  // Mount under /api
  app.use("/api", router);
};
