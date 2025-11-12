// routes/payments.js
const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { authenticateToken } = require("../middleware/auth");
const { sendEmail } = require("../utils/mailer");

const router = express.Router();

function getPool(req) {
  const pool = req.app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");
  return pool;
}

function normCode(s = "") {
  return s.toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function normName(s = "") {
  return s.toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * POST /api/payments/start
 * Body: { "plan_code": "BASIC" }  // accepts code OR human name (e.g. "basic", "Fleet Pro")
 * Uses price_cents if present, else falls back to price_amount * 100 (integer).
 */
router.post("/start", authenticateToken, async (req, res) => {
  try {
    const raw = (req.body?.plan_code || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing plan_code" });

    const pool = getPool(req);

    const sql = `
      SELECT code, name, is_active,
             COALESCE(price_cents,
                      (NULLIF(price_amount,0) * 100)::int, 0) AS effective_cents,
             COALESCE(currency, price_currency, 'KES')        AS effective_currency
      FROM subscription_plans
      WHERE UPPER(code) = UPPER($1)
         OR REGEXP_REPLACE(UPPER(name),'[^A-Z0-9]','','g')
            = REGEXP_REPLACE(UPPER($1),'[^A-Z0-9]','','g')
      LIMIT 1
    `;
    const plan = (await pool.query(sql, [raw])).rows[0];

    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: "Unknown or inactive plan_code" });
    }

    // FREE plan shortcut
    if (plan.code && plan.code.toUpperCase() === "FREE") {
      return res.json({
        ok: true,
        free: true,
        message: "Free plan selected — no payment required.",
        plan: { code: plan.code, name: plan.name }
      });
    }

    // Amount must be an integer in minor units
    let amount = parseInt(plan.effective_cents, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Plan has invalid amount",
        detail: { code: plan.code || null, name: plan.name, effective_cents: plan.effective_cents }
      });
    }

    const currency = plan.effective_currency || "KES";

    // (Optional) guard for very tiny KES amounts in LIVE – Paystack may reject too-small values
    const isTestKey = (process.env.PAYSTACK_SECRET_KEY || "").startsWith("sk_test_");
    if (!isTestKey && currency === "KES" && amount < 50) {
      // 50 (minor units) == 0.50 KES. If you see "Invalid Amount" in live, bump to >= 5000 for KES 50.00
      // For testing tiny amounts, use a test secret key.
      return res.status(400).json({
        error: "Amount likely too small for live KES",
        hint: "Use a test Paystack key for tiny test charges or raise price to a realistic minimum.",
        detail: { amount_minor: amount, currency }
      });
    }

    // Fetch user (for email & metadata)
    const user = (await pool.query(
      `SELECT id, email, name FROM users WHERE id = $1`,
      [req.user.id]
    )).rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    const reference = `S360_${user.id}_${(plan.code || normName(plan.name))}_${Date.now()}`;
    const payload = {
      email: user.email,
      amount,               // integer minor units
      currency,             // KES if you configured it on Paystack
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.APP_BASE_URL || ""}/billing/thanks`,
      metadata: {
        user_id: user.id,
        plan_code: plan.code || null,
        plan_name: plan.name
      }
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
      return res.status(400).json({
        error: "Paystack init failed",
        detail: data,
        debug_payload: payload
      });
    }

    res.json({
      ok: true,
      reference: data.data?.reference || reference,
      authorization_url: data.data?.authorization_url,
      access_code: data.data?.access_code,
      plan: {
        code: plan.code || null,
        name: plan.name,
        price_cents: amount,
        currency
      }
    });
  } catch (e) {
    console.error("payments.start error:", e);
    res.status(500).json({ error: "Failed to start payment", detail: e.message });
  }
});

/**
 * POST /api/payments/webhook  (index.js must pass RAW body for application/json)
 * Verifies signature, stores payment, flips/renews subscription, emails invoice.
 */
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    if (!signature) return res.status(400).send("Missing signature");

    const secret = process.env.PAYSTACK_SECRET_KEY || "";
    const hash = crypto.createHmac("sha512", secret).update(req.body).digest("hex");
    if (hash !== signature) return res.status(401).send("Invalid signature");

    const event = JSON.parse(req.body.toString("utf8"));

    // Only handle successful charge events
    if (event?.event !== "charge.success") return res.status(200).send("ignored");

    const d = event.data || {};
    const currency = (d.currency || "KES").toUpperCase();
    const amountMinor = parseInt(d.amount, 10) || 0; // minor units
    const amountMajor = Math.round(amountMinor) / 100; // for display
    const reference   = d.reference || "";
    const meta        = d.metadata || {};
    const planName    = meta.plan_name || "Unknown Plan";
    const planCode    = meta.plan_code ? normCode(meta.plan_code) : null;
    const userId      = meta.user_id || null;
    const status      = (d.status || "success").toLowerCase();

    const pool = getPool(req);

    // 1) Log payment
    await pool.query(
      `
      INSERT INTO payments (user_id, reference, plan_code, currency, amount_minor, status, payload, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (reference) DO UPDATE
        SET status = EXCLUDED.status,
            payload = EXCLUDED.payload
      `,
      [userId, reference, planCode, currency, amountMinor, status, event]
    );

    // 2) Flip/renew subscription (idempotent)
    if (userId) {
      const effectivePlan = planCode || normName(planName); // fallback to normalized name
      await pool.query(
        `
        INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
        VALUES ($1, $2, 'active', NOW(), NOW(), $3)
        ON CONFLICT (user_id, plan_code) DO UPDATE
          SET status='active',
              renewed_at = NOW(),
              meta = COALESCE(user_subscriptions.meta, '{}'::jsonb) || EXCLUDED.meta
        `,
        [userId, effectivePlan, event]
      );
    }

    // 3) Send invoice email (best-effort)
    try {
      if (d?.customer?.email) {
        // Optional date/periods if you want them on the invoice
        const issued_at = new Date().toISOString();
        await sendEmail(
          d.customer.email,
          "Your Saka360 Subscription Invoice",
          "subscription_invoice",
          {
            user_name: d?.customer?.first_name ? `${d.customer.first_name} ${d.customer.last_name || ""}`.trim() : "there",
            plan_name: planName,
            plan_code: planCode || normName(planName),
            amount_cents: amountMinor,
            currency,
            invoice_number: reference,
            issued_at,
            period_start: issued_at.substring(0,10),
            period_end: issued_at.substring(0,10),
            payment_link: null
          }
        );
      }
    } catch (mailErr) {
      console.error("payments.webhook: email send warning:", mailErr.message);
      // do not fail webhook because of email
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error("payments.webhook error:", e);
    res.status(500).send("error");
  }
});

/**
 * GET /api/payments/status
 * Returns current plan snapshot + simple usage caps.
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

    const planCode = (sub?.plan_code || "FREE").toUpperCase();

    const plan = (await pool.query(
      `SELECT code, name,
              COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents,
              COALESCE(currency, price_currency, 'KES') AS currency,
              features
       FROM subscription_plans
       WHERE UPPER(code) = $1`,
      [planCode]
    )).rows[0];

    const fallback = { code: 'FREE', name: 'Free', price_cents: 0, currency: 'KES', features: ['1 vehicle','basic logs'] };
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
      plan: { code: effective.code?.toUpperCase() || 'FREE', ...caps[effective.code?.toUpperCase() || 'FREE'] },
      usage: { vehicles: vehiclesCount, documents: documentsCount }
    });
  } catch (e) {
    console.error("payments.status error:", e);
    res.status(500).json({ error: "Failed to load billing status", detail: e.message });
  }
});

/**
 * GET /api/payments/_diag
 * Safe diagnostics; never references non-existent columns.
 */
router.get("/_diag", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);

    const plans = (await pool.query(
      `SELECT code, name,
              COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents,
              COALESCE(currency, price_currency, 'KES') AS currency,
              is_active
       FROM subscription_plans
       ORDER BY COALESCE(code, name)`
    )).rows;

    const payments = (await pool.query(
      `SELECT id, user_id, reference, plan_code, currency,
              amount_minor,
              ROUND((amount_minor::numeric / 100.0)::numeric, 2) AS amount_major,
              status, created_at
       FROM payments
       ORDER BY id DESC
       LIMIT 10`
    )).rows;

    res.json({
      ok: true,
      env: {
        paystack_key_present: !!process.env.PAYSTACK_SECRET_KEY,
        callback_url: process.env.PAYSTACK_CALLBACK_URL || null
      },
      sample_user: req.user?.id || null,
      plans,
      last_payments: payments
    });
  } catch (e) {
    console.error("payments._diag error:", e);
    res.status(500).json({ error: "diag failed", detail: e.message });
  }
});

module.exports = router;
