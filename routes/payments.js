// routes/payments.js
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

function getPool(req) {
  const pool = req.app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");
  return pool;
}

function norm(s = "") {
  return s.toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * POST /api/payments/start
 * Body: { plan_code: "BASIC" }  // also accepts plan name e.g. "Basic", "Fleet Pro"
 *
 * We PREFER KES from price_amount (whole shillings).
 * If missing, we fall back to price_cents/100 and round.
 */
router.post("/start", authenticateToken, async (req, res) => {
  try {
    const raw = (req.body?.plan_code || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing plan_code" });

    const pool = getPool(req);

    const sql = `
      SELECT
        code,
        name,
        price_amount,                                -- numeric (KES)
        price_cents,                                 -- legacy (cents)
        COALESCE(currency, price_currency, 'KES') AS effective_currency,
        is_active
      FROM subscription_plans
      WHERE
        UPPER(code) = UPPER($1)
        OR REGEXP_REPLACE(UPPER(name),'[^A-Z0-9]','','g')
           = REGEXP_REPLACE(UPPER($1),'[^A-Z0-9]','','g')
      LIMIT 1
    `;
    const plan = (await pool.query(sql, [raw])).rows[0];

    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: "Unknown or inactive plan_code" });
    }

    // FREE plan → nothing to charge
    if (plan.code && plan.code.toUpperCase() === "FREE") {
      return res.json({
        ok: true,
        free: true,
        message: "Free plan selected — no payment required.",
        plan: { code: plan.code, name: plan.name }
      });
    }

    // Prefer whole shillings from price_amount
    let amountKES = Number(plan.price_amount);
    if (!Number.isFinite(amountKES) || amountKES <= 0) {
      // Fallback to cents → KES
      const cents = Number.parseInt(plan.price_cents, 10);
      if (!Number.isFinite(cents) || cents <= 0) {
        return res.status(400).json({
          error: "Plan has invalid amount",
          detail: { code: plan.code, name: plan.name, price_amount: plan.price_amount, price_cents: plan.price_cents }
        });
      }
      amountKES = Math.round(cents / 100);
    } else {
      amountKES = Math.round(amountKES); // ensure whole KES
    }

    if (amountKES <= 0) {
      return res.status(400).json({
        error: "Invalid plan amount after normalization",
        detail: { code: plan.code, name: plan.name, price_amount: plan.price_amount, price_cents: plan.price_cents }
      });
    }

    const currency = plan.effective_currency || "KES";

    // Fetch the user for email/reference
    const user = (await pool.query(
      `SELECT id, email, name FROM users WHERE id=$1`,
      [req.user.id]
    )).rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    const reference = `S360_${user.id}_${(plan.code || "PLAN").toUpperCase()}_${Date.now()}`;
    const payload = {
      email: user.email,
      amount: amountKES, // integer KES for Paystack
      currency,
      reference,
      callback_url:
        process.env.PAYSTACK_CALLBACK_URL ||
        `${process.env.APP_BASE_URL || ""}/billing/thanks`,
      metadata: { user_id: user.id, plan_code: plan.code, plan_name: plan.name },
    };

    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!data?.status) {
      return res.status(400).json({
        error: "Paystack init failed",
        detail: data,
        debug_payload: payload
      });
    }

    return res.json({
      ok: true,
      reference: data.data?.reference || reference,
      authorization_url: data.data?.authorization_url,
      access_code: data.data?.access_code,
      plan: {
        code: plan.code,
        name: plan.name,
        amount_kes: amountKES,
        currency: currency
      }
    });
  } catch (e) {
    console.error("payments.start error:", e);
    res.status(500).json({ error: "Failed to start payment", detail: e.message });
  }
});

/**
 * POST /api/payments/webhook  (raw body required in index.js)
 */
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];
    if (!signature) return res.status(400).send("Missing signature");

    const hash = crypto.createHmac("sha512", secret).update(req.body).digest("hex");
    if (hash !== signature) return res.status(401).send("Invalid signature");

    const payload = JSON.parse(req.body.toString("utf8"));
    if (payload?.event !== "charge.success") return res.status(200).send("ignored");

    const meta = payload?.data?.metadata || {};
    const user_id = meta.user_id;
    const plan_code = meta.plan_code;
    if (!user_id || !plan_code) return res.status(200).send("ok");

    const pool = getPool(req);
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
 * GET /api/payments/status
 */
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);

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
      `SELECT code, name,
              price_amount,                               -- KES
              COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents_fallback,
              COALESCE(currency, price_currency, 'KES') AS currency,
              features
       FROM subscription_plans WHERE UPPER(code) = UPPER($1)`,
      [planCode]
    )).rows[0];

    const fallback = {
      code: "FREE",
      name: "Free",
      price_amount: 0,
      currency: "KES",
      features: ["1 vehicle", "basic logs"],
    };
    const effective = plan || fallback;

    const vehiclesCount = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM vehicles WHERE user_id = $1`,
      [req.user.id]
    )).rows[0]?.c || 0;

    const documentsCount = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM documents WHERE user_id = $1`,
      [req.user.id]
    )).rows[0]?.c || 0;

    const caps = {
      FREE:     { maxVehicles: 1,   docsEnabled: false, whatsappReminders: false },
      BASIC:    { maxVehicles: 3,   docsEnabled: true,  whatsappReminders: true  },
      PREMIUM:  { maxVehicles: 999, docsEnabled: true,  whatsappReminders: true  },
      FLEETPRO: { maxVehicles: 999, docsEnabled: true,  whatsappReminders: true  },
    };

    res.json({
      plan: { code: effective.code, ...caps[effective.code] },
      usage: { vehicles: vehiclesCount, documents: documentsCount }
    });
  } catch (e) {
    console.error("billing.status error:", e);
    res.status(500).json({ error: "Failed to load billing status", detail: e.message });
  }
});

module.exports = router;
