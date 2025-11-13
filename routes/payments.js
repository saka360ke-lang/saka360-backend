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

async function getPlanByAny(pool, raw) {
  const sql = `
    SELECT code, name,
           COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents,
           COALESCE(currency, price_currency, 'KES') AS currency,
           COALESCE(is_active, TRUE) AS is_active
    FROM subscription_plans
    WHERE
      UPPER(code) = UPPER($1)
      OR REGEXP_REPLACE(UPPER(name),'[^A-Z0-9]','','g') = REGEXP_REPLACE(UPPER($1),'[^A-Z0-9]','','g')
    LIMIT 1
  `;
  return (await pool.query(sql, [raw])).rows[0];
}

/* -----------------------------
 * POST /api/payments/start
 * ----------------------------- */
router.post("/start", authenticateToken, async (req, res) => {
  try {
    const raw = (req.body?.plan_code || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing plan_code" });

    const pool = getPool(req);
    const plan = await getPlanByAny(pool, raw);

    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: "Unknown or inactive plan_code" });
    }

    if ((plan.code || "").toUpperCase() === "FREE") {
      return res.json({
        ok: true,
        free: true,
        message: "Free plan selected — no payment required.",
        plan: { code: plan.code, name: plan.name }
      });
    }

    const amount = parseInt(plan.price_cents, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "Plan has invalid amount",
        detail: { code: plan.code, name: plan.name, price_cents: plan.price_cents }
      });
    }

    const currency = plan.currency || "KES";
    const user = (await pool.query(`SELECT id, email, name FROM users WHERE id=$1`, [req.user.id])).rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    const reference = `S360_${user.id}_${(plan.code || "").toUpperCase()}_${Date.now()}`;
    const payload = {
      email: user.email,
      amount,
      currency,
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.APP_BASE_URL || ""}/billing/thanks`,
      metadata: { user_id: user.id, plan_code: (plan.code || "").toUpperCase(), plan_name: plan.name }
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
      return res.status(400).json({ error: "Paystack init failed", detail: data, debug_payload: payload });
    }

    res.json({
      ok: true,
      reference: data.data?.reference || reference,
      authorization_url: data.data?.authorization_url,
      access_code: data.data?.access_code,
      plan: {
        code: (plan.code || "").toUpperCase(),
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

/* -----------------------------
 * POST /api/payments/webhook
 * (raw body; index.js already ensures raw)
 * ----------------------------- */
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers["x-paystack-signature"];
    if (!signature) return res.status(400).send("Missing signature");

    const computed = crypto.createHmac("sha512", secret).update(req.body).digest("hex");
    if (computed !== signature) return res.status(401).send("Invalid signature");

    const evt = JSON.parse(req.body.toString("utf8"));
    if (evt?.event !== "charge.success") return res.status(200).send("ignored");

    const data = evt.data || {};
    const meta = data.metadata || {};
    const reference = data.reference;
    const amount_cents = Number(data.amount) || 0;         // minor units
    const currency = (data.currency || "KES").toUpperCase();
    const channel  = (data.channel || "").toString();
    const status   = (data.status  || "success").toString();

    const user_id  = meta.user_id || null;
    const planCode = (meta.plan_code || "").toUpperCase() || null;

    const pool = getPool(req);

    // Record payment (your existing columns)
    await pool.query(
      `
      INSERT INTO payments (user_id, provider, reference, amount_cents, currency, channel, plan_code, status, raw, created_at)
      VALUES ($1, 'paystack', $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
      ON CONFLICT (reference) DO NOTHING
      `,
      [user_id, reference, amount_cents, currency, channel, planCode, status, JSON.stringify(evt)]
    );

    // Upsert subscription
    if (user_id && planCode) {
      await pool.query(
        `
        INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
        VALUES ($1, $2, 'active', NOW(), NOW(), $3)
        ON CONFLICT (user_id, plan_code)
        DO UPDATE SET status='active', renewed_at=NOW(), meta = COALESCE(user_subscriptions.meta, '{}'::jsonb) || EXCLUDED.meta
        `,
        [user_id, planCode, evt]
      );
    }

    // Send invoice email
    if (user_id) {
      const user = (await pool.query(`SELECT email, name FROM users WHERE id=$1`, [user_id])).rows[0];
      if (user?.email) {
        const planRow = (await pool.query(
          `SELECT name FROM subscription_plans WHERE UPPER(code)=UPPER($1) LIMIT 1`,
          [planCode]
        )).rows[0];
        const plan_name = planRow?.name || planCode || "Subscription";

        const issued_at = new Date().toISOString();
        const period_start = new Date().toISOString().slice(0,10);
        const period_end   = new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0,10);
        const invoice_number = `INV-${reference}`;

        try {
          await sendEmail(
            user.email,
            "Your Saka360 Subscription Invoice",
            "subscription_invoice", // keep same template key you used in admin tests
            {
              user_name: user.name || "there",
              plan_name,
              plan_code: planCode || "",
              amount_cents,
              currency,
              invoice_number,
              issued_at,
              period_start,
              period_end,
              payment_link: (process.env.APP_BASE_URL || "https://app.saka360.com") + "/billing"
            }
          );
        } catch (mailErr) {
          console.error("invoice email send warning:", mailErr.message);
        }
      }
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.error("payments.webhook error:", e);
    return res.status(500).send("error");
  }
});

/* -----------------------------
 * GET /api/payments/status
 * Try subscription; if missing, adopt latest successful payment.
 * ----------------------------- */
router.get("/status", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);

    // 1) try user_subscriptions
    let sub = (await pool.query(
      `SELECT plan_code, status, started_at, renewed_at
       FROM user_subscriptions
       WHERE user_id = $1
       ORDER BY COALESCE(renewed_at, started_at) DESC
       LIMIT 1`,
      [req.user.id]
    )).rows[0];

    // 2) if none, check latest successful payment and backfill
    if (!sub) {
      const pay = (await pool.query(
        `SELECT plan_code
           FROM payments
          WHERE user_id = $1 AND status = 'success' AND plan_code IS NOT NULL
          ORDER BY id DESC
          LIMIT 1`,
        [req.user.id]
      )).rows[0];

      if (pay?.plan_code) {
        // create a subscription row
        await pool.query(
          `INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
           VALUES ($1, $2, 'active', NOW(), NOW(), '{}'::jsonb)
           ON CONFLICT (user_id, plan_code)
           DO UPDATE SET status='active', renewed_at=NOW()`,
          [req.user.id, pay.plan_code]
        );

        sub = { plan_code: pay.plan_code, status: "active" };
      }
    }

    const planCode = (sub?.plan_code || 'FREE').toUpperCase();

    const plan = (await pool.query(
      `SELECT code, name,
              COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents,
              COALESCE(currency, price_currency, 'KES') AS currency,
              features
       FROM subscription_plans WHERE UPPER(code) = UPPER($1)`,
      [planCode]
    )).rows[0];

    const fallback = { code: 'FREE', name: 'Free', price_cents: 0, currency: 'KES', features: '1 vehicle,basic logs' };
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
      plan: { code: planCode, ...(caps[planCode] || caps.FREE) },
      usage: { vehicles: vehiclesCount, documents: documentsCount }
    });
  } catch (e) {
    console.error("billing.status error:", e);
    res.status(500).json({ error: "Failed to load billing status", detail: e.message });
  }
});

/* -----------------------------
 * GET /api/payments/_diag
 * ----------------------------- */
router.get("/_diag", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='payments'
       ORDER BY ordinal_position`
    )).rows.map(r => r.column_name);

    const sample = (await pool.query(
      `SELECT id, user_id, provider, reference, amount_cents, currency, channel, plan_code, status, created_at
       FROM payments
       ORDER BY id DESC
       LIMIT 5`
    )).rows;

    res.json({ ok: true, columns: cols, sample });
  } catch (e) {
    res.status(500).json({ error: "diag failed", detail: e.message });
  }
});

module.exports = router;
