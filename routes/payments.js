// routes/payments.js
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");

const router = express.Router();

/**
 * Utility: get shared PG pool from app
 */
function getPool(req) {
  const pool = req.app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");
  return pool;
}

/**
 * Utility: require auth middleware (your existing one)
 */
const { authenticateToken } = require("../middleware/auth");

/**
 * POST /api/payments/start
 * Body: { plan_code: "BASIC" }
 * - Reads price from subscription_plans.price_cents in KES
 * - Initializes a Paystack transaction (no plan codes)
 * - Returns authorization_url for user to complete payment
 */
router.post("/start", authenticateToken, async (req, res) => {
  try {
    const { plan_code } = req.body || {};
    if (!plan_code) return res.status(400).json({ error: "Missing plan_code" });

    const pool = getPool(req);

    // find plan from DB
    const planSql = `
      SELECT code, name, price_cents, currency
      FROM subscription_plans
      WHERE code = $1 AND is_active = TRUE
      LIMIT 1
    `;
    const plan = (await pool.query(planSql, [plan_code])).rows[0];
    if (!plan) return res.status(400).json({ error: "Unknown or inactive plan_code" });
    if ((plan.currency || "KES") !== "KES") {
      return res.status(400).json({ error: "Only KES plans are supported right now" });
    }

    // get the current user email from DB (based on req.user.id)
    const u = (await pool.query(`SELECT id, email, name FROM users WHERE id = $1`, [req.user.id])).rows[0];
    if (!u) return res.status(401).json({ error: "User not found" });

    const reference = `S360_${req.user.id}_${plan.code}_${Date.now()}`;
    const amount = plan.price_cents; // already in KES cents (Paystack expects lowest unit)

    const payload = {
      email: u.email,
      amount,
      currency: "KES",
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.APP_BASE_URL || ""}/billing/thanks`,
      metadata: {
        user_id: req.user.id,
        plan_code: plan.code,
        plan_name: plan.name,
      },
    };

    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!data?.status) {
      return res.status(400).json({ error: "Paystack init failed", detail: data });
    }

    return res.json({
      ok: true,
      reference: data.data?.reference || reference,
      authorization_url: data.data?.authorization_url,
      access_code: data.data?.access_code,
    });
  } catch (e) {
    console.error("payments.start error:", e);
    res.status(500).json({ error: "Failed to start payment", detail: e.message });
  }
});

/**
 * POST /api/payments/webhook
 * Paystack will POST here (raw body needed to verify signature)
 * Expect: event === 'charge.success'
 * We will: upsert user_subscriptions (activate chosen plan)
 */
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];

    if (!signature) return res.status(400).send("Missing signature");

    const hash = crypto
      .createHmac("sha512", secret)
      .update(req.body) // raw Buffer
      .digest("hex");

    if (hash !== signature) {
      console.warn("Paystack signature mismatch");
      return res.status(401).send("Invalid signature");
    }

    const payload = JSON.parse(req.body.toString("utf8"));
    if (payload?.event !== "charge.success") {
      return res.status(200).send("ignored");
    }

    const meta = payload?.data?.metadata || {};
    const user_id = meta.user_id;
    const plan_code = meta.plan_code;

    if (!user_id || !plan_code) {
      console.warn("webhook missing user_id/plan_code in metadata");
      return res.status(200).send("ok");
    }

    const pool = getPool(req);

    // Upsert: one "current" subscription row (simple approach)
    await pool.query(
      `
      INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
      VALUES ($1, $2, 'active', NOW(), NOW(), $3)
      ON CONFLICT (user_id, plan_code) DO UPDATE
        SET status='active',
            renewed_at = NOW(),
            meta = COALESCE(user_subscriptions.meta, '{}'::jsonb) || EXCLUDED.meta
      `,
      [user_id, plan_code, payload]
    );

    return res.status(200).send("ok");
  } catch (e) {
    console.error("payments.webhook error:", e);
    res.status(500).send("error");
  }
});

/**
 * GET /api/billing/status
 * Returns the user's current plan and usage (very similar to your previous status route)
 */
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);

    // naive: pick the most recently renewed subscription as "current"
    const sub = (await pool.query(
      `SELECT plan_code, status, started_at, renewed_at
       FROM user_subscriptions
       WHERE user_id = $1
       ORDER BY COALESCE(renewed_at, started_at) DESC
       LIMIT 1`,
      [req.user.id]
    )).rows[0];

    const planCode = sub?.plan_code || "FREE";

    const plan = (await pool.query(
      `SELECT code, name, price_cents, currency, features
       FROM subscription_plans WHERE code = $1`,
      [planCode]
    )).rows[0] || {
      code: "FREE",
      name: "Free",
      price_cents: 0,
      currency: "KES",
      features: ["1 vehicle","basic logs"]
    };

    // usage (adjust to your schema)
    const vehiclesCount = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM vehicles WHERE user_id = $1`,
      [req.user.id]
    )).rows[0]?.c || 0;

    const documentsCount = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM documents WHERE user_id = $1`,
      [req.user.id]
    )).rows[0]?.c || 0;

    // simple caps based on plan code
    const caps = {
      FREE:     { maxVehicles: 1,   docsEnabled: false, whatsappReminders: false },
      BASIC:    { maxVehicles: 3,   docsEnabled: true,  whatsappReminders: true  },
      PREMIUM:  { maxVehicles: 999, docsEnabled: true,  whatsappReminders: true  },
      FLEETPRO: { maxVehicles: 999, docsEnabled: true,  whatsappReminders: true  },
    };

    res.json({
      plan: { code: plan.code, ...caps[plan.code] },
      usage: { vehicles: vehiclesCount, documents: documentsCount }
    });
  } catch (e) {
    console.error("billing.status error:", e);
    res.status(500).json({ error: "Failed to load billing status", detail: e.message });
  }
});

module.exports = router;
