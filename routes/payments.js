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

/* -------------------------------------------
 * Helpers: table/column introspection + logging
 * ------------------------------------------- */
async function getPaymentsColumns(pool) {
  const cols = (await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='payments'`
  )).rows.map(r => r.column_name);

  return {
    cols,
    has: (name) => cols.includes(name),
  };
}

async function logPayment(pool, fields) {
  // fields: { user_id, reference, plan_code, currency, amount_minor, status, payloadObj }
  const meta = await getPaymentsColumns(pool);

  const columns = ["created_at"];
  const values = ["NOW()"];
  const params = [];
  let i = 1;

  function add(colName, val) {
    columns.push(colName);
    values.push(`$${i++}`);
    params.push(val);
  }

  if (meta.has("user_id") && fields.user_id != null) add("user_id", fields.user_id);
  if (meta.has("reference") && fields.reference) add("reference", fields.reference);
  if (meta.has("plan_code") && fields.plan_code) add("plan_code", fields.plan_code);
  if (meta.has("currency") && fields.currency) add("currency", fields.currency);

  // amount: prefer amount_minor → else amount_cents → else skip
  if (Number.isFinite(fields.amount_minor)) {
    if (meta.has("amount_minor")) add("amount_minor", fields.amount_minor);
    else if (meta.has("amount_cents")) add("amount_cents", fields.amount_minor);
  }

  if (meta.has("status") && fields.status) add("status", fields.status);

  // payload: prefer 'payload' → else 'raw' if present
  const payloadJSON = fields.payloadObj ? JSON.stringify(fields.payloadObj) : null;
  if (payloadJSON) {
    if (meta.has("payload")) add("payload", payloadJSON);
    else if (meta.has("raw")) add("raw", payloadJSON);
  }

  const sql = `
    INSERT INTO payments (${columns.join(", ")})
    VALUES (${values.join(", ")})
    ON CONFLICT (${meta.has("reference") ? "reference" : "id"}) DO UPDATE
      SET ${columns
        .filter(c => c !== (meta.has("reference") ? "reference" : "id") && c !== "created_at")
        .map(c => `${c}=EXCLUDED.${c}`)
        .join(", ")}
  `;

  return pool.query(sql, params);
}

/* -------------------------------------------
 * POST /api/payments/start
 * Body: { plan_code: "BASIC" } // also accepts "Basic" / "Fleet Pro"
 * ------------------------------------------- */
router.post("/start", authenticateToken, async (req, res) => {
  try {
    const raw = (req.body?.plan_code || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing plan_code" });

    const pool = getPool(req);

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

    // FREE -> no charge
    if ((plan.code || "").toUpperCase() === "FREE") {
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

    const user = (await pool.query(`SELECT id, email, name FROM users WHERE id=$1`, [req.user.id])).rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    const planCode = (plan.code || norm(plan.name)).toUpperCase();
    const reference = `S360_${user.id}_${planCode}_${Date.now()}`;

    const payload = {
      email: user.email,
      amount: amount,               // integer, smallest unit
      currency: currency,
      reference,
      callback_url: process.env.PAYSTACK_CALLBACK_URL || `${process.env.APP_BASE_URL || ""}/billing/thanks`,
      metadata: { user_id: user.id, plan_code: planCode, plan_name: plan.name },
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
        code: planCode,
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

/* -------------------------------------------
 * POST /api/payments/webhook  (raw body)
 * ------------------------------------------- */
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
    const amount_minor = payload?.data?.amount; // smallest unit (kobo/cents)

    if (!user_id || !plan_code) return res.status(200).send("ok");

    const pool = getPool(req);

    // Log payment in a schema-agnostic way
    await logPayment(pool, {
      user_id,
      reference: payload?.data?.reference || null,
      plan_code,
      currency,
      amount_minor: Number.isFinite(amount_minor) ? amount_minor : null,
      status: "paid",
      payloadObj: payload
    });

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

    // Fire-and-forget email (don’t break webhook)
    try {
      const { sendEmail } = require("../utils/mailer");
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
            amount_cents: amount_minor || 0,
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

/* -------------------------------------------
 * GET /api/payments/status
 * ------------------------------------------- */
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
    console.error("billing.status error:", e);
    res.status(500).json({ error: "Failed to load billing status", detail: e.message });
  }
});

/* -------------------------------------------
 * GET /api/payments/_diag (never 500s)
 * ------------------------------------------- */
router.get("/_diag", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const meta = await getPaymentsColumns(pool);

    const payments = (await pool.query(
      `
      SELECT
        id,
        ${meta.has("user_id") ? "user_id" : "NULL::bigint AS user_id"},
        ${meta.has("provider") ? "provider" : "NULL::text AS provider"},
        ${meta.has("reference") ? "reference" : "NULL::text AS reference"},
        ${meta.has("amount_minor") ? "amount_minor" : (meta.has("amount_cents") ? "amount_cents" : "NULL::integer AS amount_minor")},
        ${meta.has("currency") ? "currency" : "NULL::text AS currency"},
        ${meta.has("channel") ? "channel" : "NULL::text AS channel"},
        ${meta.has("plan_code") ? "plan_code" : "NULL::text AS plan_code"},
        ${meta.has("status") ? "status" : "NULL::text AS status"},
        ${meta.has("raw") ? "raw" : (meta.has("payload") ? "payload" : "NULL::jsonb AS raw")},
        ${meta.has("created_at") ? "created_at" : "NOW() AS created_at"}
      FROM payments
      ORDER BY id DESC
      LIMIT 20
      `
    )).rows;

    res.json({ ok: true, columns: meta.cols, sample: payments });
  } catch (e) {
    console.error("payments._diag error:", e);
    res.status(500).json({ error: "diag failed", detail: e.message });
  }
});

module.exports = router;
