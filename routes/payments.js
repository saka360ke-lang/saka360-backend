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

// --- helpers -------------------------------------------------

async function fetchPlanByAny(pool, raw) {
  const sql = `
    SELECT
      /* robust code even if DB code is null */
      COALESCE(NULLIF(TRIM(code), ''), UPPER(REGEXP_REPLACE(name,'[^A-Za-z0-9]','','g'))) AS code,
      name,
      COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) AS price_cents,
      COALESCE(currency, price_currency, 'KES') AS currency,
      COALESCE(is_active, TRUE) AS is_active
    FROM subscription_plans
    WHERE
      UPPER(code) = UPPER($1)
      OR REGEXP_REPLACE(UPPER(name),'[^A-Z0-9]','','g') = REGEXP_REPLACE(UPPER($1),'[^A-Z0-9]','','g')
    LIMIT 1
  `;
  const row = (await pool.query(sql, [raw])).rows[0];
  if (!row) return null;
  row.code = (row.code || "").toUpperCase();
  return row;
}

async function fetchPlanByAmount(pool, amountCents) {
  const sql = `
    SELECT
      COALESCE(NULLIF(TRIM(code), ''), UPPER(REGEXP_REPLACE(name,'[^A-Za-z0-9]','','g'))) AS code,
      name
    FROM subscription_plans
    WHERE COALESCE(price_cents, (NULLIF(price_amount,0) * 100)::int, 0) = $1
    LIMIT 1
  `;
  const row = (await pool.query(sql, [amountCents])).rows[0];
  if (!row) return null;
  row.code = (row.code || "").toUpperCase();
  return row;
}

// --- start checkout ------------------------------------------

router.post("/start", authenticateToken, async (req, res) => {
  try {
    const raw = (req.body?.plan_code || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing plan_code" });

    const pool = getPool(req);
    const plan = await fetchPlanByAny(pool, raw);

    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: "Unknown or inactive plan_code" });
    }

    if (plan.code === "FREE") {
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

    const reference = `S360_${user.id}_${plan.code}_${Date.now()}`;
    const payload = {
      email: user.email,
      amount: amount,         // integer minor units
      currency: currency,     // KES
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.APP_BASE_URL || ""}/billing/thanks`,
      metadata: { user_id: user.id, plan_code: plan.code, plan_name: plan.name },
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
        code: plan.code,
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

// --- webhook -------------------------------------------------

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

    const reference     = data.reference;
    const amount_cents  = Number(data.amount) || 0;
    const currency      = (data.currency || "KES").toUpperCase();
    const channel       = (data.channel || "").toString();
    const status        = (data.status  || "success").toString();

    const user_id_meta  = meta.user_id || null;
    let plan_code_meta  = (meta.plan_code || meta.plan || meta.planCode || "").toString().toUpperCase();

    const pool = getPool(req);

    // If metadata missing (common in some test flows), derive by amount
    if (!plan_code_meta) {
      const p = await fetchPlanByAmount(pool, amount_cents);
      plan_code_meta = p?.code || null;
    }

    // Log payment (upsert by reference)
    await pool.query(
      `
      INSERT INTO payments (user_id, provider, reference, amount_cents, currency, channel, plan_code, status, raw, created_at)
      VALUES ($1,'paystack',$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
      ON CONFLICT (reference) DO UPDATE
        SET user_id   = COALESCE(EXCLUDED.user_id, payments.user_id),
            amount_cents = EXCLUDED.amount_cents,
            currency  = EXCLUDED.currency,
            channel   = EXCLUDED.channel,
            plan_code = COALESCE(EXCLUDED.plan_code, payments.plan_code),
            status    = EXCLUDED.status,
            raw       = EXCLUDED.raw
      `,
      [user_id_meta, reference, amount_cents, currency, channel, plan_code_meta, status, JSON.stringify(evt)]
    );

    // Upsert subscription if we have both user and plan
    if (user_id_meta && plan_code_meta) {
      await pool.query(
        `
        INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
        VALUES ($1, $2, 'active', NOW(), NOW(), $3)
        ON CONFLICT (user_id, plan_code)
        DO UPDATE SET status='active', renewed_at=NOW(),
                      meta = COALESCE(user_subscriptions.meta, '{}'::jsonb) || EXCLUDED.meta
        `,
        [user_id_meta, plan_code_meta, evt]
      );
    }

    // Email invoice (uses the same template key that worked in your admin tests)
    if (user_id_meta) {
      const user = (await pool.query(`SELECT email, name FROM users WHERE id=$1`, [user_id_meta])).rows[0];
      if (user?.email) {
        const planRow = plan_code_meta
          ? (await pool.query(`SELECT name FROM subscription_plans WHERE UPPER(code)=UPPER($1) LIMIT 1`, [plan_code_meta])).rows[0]
          : null;

        const plan_name = planRow?.name || plan_code_meta || "Subscription";
        const issued_at = new Date().toISOString();
        const period_start = new Date().toISOString().slice(0,10);
        const period_end   = new Date(Date.now() + 30*24*60*60*1000).toISOString().slice(0,10);
        const invoice_number = `INV-${reference}`;

        try {
          await sendEmail(
            user.email,
            "Your Saka360 Subscription Invoice",
            "subscription_invoice",       // <-- template key (singular) matches your working admin test
            {
              user_name: user.name || "there",
              plan_name,
              plan_code: plan_code_meta || "",
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

// --- status --------------------------------------------------

router.get("/status", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);

    // First, try existing subscription
    let sub = (await pool.query(
      `SELECT plan_code, status FROM user_subscriptions
       WHERE user_id = $1
       ORDER BY COALESCE(renewed_at, started_at) DESC
       LIMIT 1`,
      [req.user.id]
    )).rows[0];

    // If none, check latest successful payment and adopt (derive plan if needed)
    if (!sub) {
      const pay = (await pool.query(
        `SELECT plan_code, amount_cents
           FROM payments
          WHERE user_id = $1 AND status = 'success'
          ORDER BY id DESC
          LIMIT 1`,
        [req.user.id]
      )).rows[0];

      let planCode = (pay?.plan_code || "").toUpperCase();
      if (!planCode && pay?.amount_cents) {
        const p = await fetchPlanByAmount(pool, pay.amount_cents);
        planCode = p?.code || "";
      }

      if (planCode) {
        await pool.query(
          `INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
           VALUES ($1, $2, 'active', NOW(), NOW(), '{}'::jsonb)
           ON CONFLICT (user_id, plan_code)
           DO UPDATE SET status='active', renewed_at=NOW()`,
          [req.user.id, planCode]
        );
        sub = { plan_code: planCode, status: "active" };
      }
    }

    const code = (sub?.plan_code || 'FREE').toUpperCase();

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
      plan: { code, ...(caps[code] || caps.FREE) },
      usage: { vehicles: vehiclesCount, documents: documentsCount }
    });
  } catch (e) {
    console.error("billing.status error:", e);
    res.status(500).json({ error: "Failed to load billing status", detail: e.message });
  }
});

// --- diag ----------------------------------------------------

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
