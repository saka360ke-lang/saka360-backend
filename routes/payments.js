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

/** Normalize helper for names/codes */
function norm(s = "") {
  return s.toString().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * POST /api/payments/start
 * Body: { plan_code: "BASIC" }  // also accepts plan name e.g., "Basic", "Fleet Pro"
 */
router.post("/start", authenticateToken, async (req, res) => {
  try {
    const raw = (req.body?.plan_code || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing plan_code" });

    const pool = getPool(req);

    // Match by code OR normalized name (supports "basic", "Basic", "BASIC", "Fleet Pro")
    const sql = `
      SELECT code, name, is_active,
             COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS effective_cents,
             COALESCE(currency, price_currency, 'KES') AS effective_currency
      FROM subscription_plans
      WHERE
        UPPER(code) = UPPER($1)
        OR REGEXP_REPLACE(UPPER(name),'[^A-Z0-9]','','g') = REGEXP_REPLACE(UPPER($1),'[^A-Z0-9]','','g')
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

    const amount = parseInt(plan.effective_cents, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Plan has invalid amount",
        detail: { code: plan.code, name: plan.name, effective_cents: plan.effective_cents }
      });
    }

    const currency = plan.effective_currency || "KES";

    // Fetch the user for email/reference
    const user = (await pool.query(`SELECT id, email, name FROM users WHERE id=$1`, [req.user.id])).rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    const reference = `S360_${user.id}_${plan.code || norm(plan.name)}_${Date.now()}`;
    const payload = {
      email: user.email,
      amount: amount,         // integer (e.g., 500 == KES 5.00 if currency is KES?)
      currency: currency,     // 'KES'
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.APP_BASE_URL || ""}/billing/thanks`,
      metadata: { user_id: user.id, plan_code: plan.code || norm(plan.name), plan_name: plan.name },
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

    return res.json({
      ok: true,
      reference: data.data?.reference || reference,
      authorization_url: data.data?.authorization_url,
      access_code: data.data?.access_code,
      plan: {
        code: plan.code || norm(plan.name),
        name: plan.name,
        price_cents: amount,
        currency: currency
      }
    });
  } catch (e) {
    console.error("payments.start error:", e);
    res.status(500).json({ error: "Failed to start payment", detail: e.message });
  }
});

/**
 * POST /api/payments/webhook
 * NOTE: index.js skips global JSON parsing for this path.
 * We declare express.raw here to receive raw bytes for signature verification.
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
    const plan_code = (meta.plan_code || "").toUpperCase();
    const currency = payload?.data?.currency || "KES";
    const amount_minor = payload?.data?.amount; // Paystack sends in kobo/cents

    if (!user_id || !plan_code) return res.status(200).send("ok"); // nothing to do

    const pool = getPool(req);

    // Ensure payments table has the column (belt-and-braces)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='payments' AND column_name='amount_minor'
        ) THEN
          ALTER TABLE public.payments ADD COLUMN amount_minor INTEGER;
        END IF;
      END$$;
    `);

    // Log payment
    await pool.query(
      `INSERT INTO payments (user_id, reference, plan_code, currency, amount_minor, status, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (reference) DO UPDATE
         SET status=EXCLUDED.status,
             payload=EXCLUDED.payload`,
      [
        user_id,
        payload?.data?.reference || null,
        plan_code,
        currency,
        Number.isFinite(amount_minor) ? amount_minor : null,
        "paid",
        payload
      ]
    );

    // Upsert subscription
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

    // Email invoice (fire-and-forget; don't break webhook flow if it fails)
    try {
      const { sendEmail } = require("../utils/mailer");
      // Calculate major amount for the template (KES: divide by 100)
      const major = Number.isFinite(amount_minor) ? (amount_minor / 100).toFixed(0) : "—";
      // Fetch user email for the invoice
      const u = (await pool.query(`SELECT email, name FROM users WHERE id=$1`, [user_id])).rows[0];

      if (u?.email) {
        await sendEmail(
          u.email,
          "Your Saka360 Subscription Invoice",
          "subscription_invoice",
          {
            user_name: u.name || "there",
            plan_name: plan_code,
            plan_code,
            amount_cents: amount_minor,
            currency,
            invoice_number: payload?.data?.reference || `INV-${Date.now()}`,
            issued_at: new Date().toISOString(),
            period_start: new Date().toISOString().slice(0,10),
            period_end: new Date(Date.now()+27*86400000).toISOString().slice(0,10),
            payment_link: null
          }
        );
      }
    } catch (e) {
      console.error("payments.webhook email warn:", e.message);
    }

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

    const planCode = (sub?.plan_code || "FREE").toUpperCase();

    const plan = (await pool.query(
      `SELECT code, name,
              COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents,
              COALESCE(currency, price_currency, 'KES') AS currency,
              features
       FROM subscription_plans WHERE UPPER(code) = $1`,
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
    console.error("billing.status error:", e);
    res.status(500).json({ error: "Failed to load billing status", detail: e.message });
  }
});

/**
 * GET /api/payments/_diag
 * Robust diag: never crashes if a column is missing; returns what it can.
 */
router.get("/_diag", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);

    // Discover columns so we don't ever SELECT a missing column
    const cols = (await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='payments'`
    )).rows.map(r => r.column_name);

    const has_amount_minor = cols.includes("amount_minor");

    const payments = (await pool.query(
      `
      SELECT
        id, user_id, reference, plan_code, currency,
        ${has_amount_minor ? "amount_minor" : "NULL::integer AS amount_minor"},
        status, created_at
      FROM payments
      ORDER BY id DESC
      LIMIT 20
      `
    )).rows;

    res.json({
      ok: true,
      columns: cols,
      sample: payments
    });
  } catch (e) {
    console.error("payments._diag error:", e);
    res.status(500).json({ error: "diag failed", detail: e.message });
  }
});

module.exports = router;
