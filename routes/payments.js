// routes/payments.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");

// Pull shared pool + mailer via app.get("pool") and utils/mailer
// (We will still make a local fallback pool if needed, but prefer app.get("pool"))
const { Pool } = require("pg");
const fallbackPool = new Pool({ connectionString: process.env.DATABASE_URL });

const { sendEmail } = require("../utils/mailer");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY;
const PAYSTACK_BASE = process.env.PAYSTACK_BASE || "https://api.paystack.co";
const APP_PUBLIC_BASE = process.env.APP_PUBLIC_BASE || "https://app.saka360.com";

// ------------------------------
// Helpers (Paystack + DB)
// ------------------------------

// Use global fetch (Node 20+)
async function psFetch(path, opts = {}) {
  const url = `${PAYSTACK_BASE}${path}`;
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Bearer ${PAYSTACK_SECRET_KEY}`);
  headers.set("Content-Type", "application/json");
  const res = await fetch(url, { ...opts, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    const msg = json?.message || res.statusText || "Paystack API error";
    throw new Error(`Paystack API failed: ${msg}`);
  }
  return json;
}

// Initialize Transaction (one-off)
async function initializeTransaction({ email, amount_minor, currency = "KES", metadata = {}, channels = undefined, callback_url = undefined, plan = undefined }) {
  const body = { email, amount: amount_minor, currency, metadata };
  if (Array.isArray(channels) && channels.length) body.channels = channels;
  if (callback_url) body.callback_url = callback_url;
  if (plan) body.plan = plan; // If provided, Paystack will create a subscription after card auth

  const json = await psFetch("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return json.data; // { authorization_url, reference }
}

// Create (or fetch) Paystack customer for recurring
async function ensurePaystackCustomer(email, first_name, last_name) {
  // Paystack auto-upserts by email on create; safe to call directly
  const json = await psFetch("/customer", {
    method: "POST",
    body: JSON.stringify({ email, first_name, last_name }),
  });
  return json.data; // { customer_code, ... }
}

// Signature check
function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !PAYSTACK_SECRET_KEY) return false;
  const hmac = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY);
  const digest = hmac.update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(digest));
  } catch {
    return false;
  }
}

function getPool(req) {
  return req.app?.get("pool") || fallbackPool;
}

// Fetch an active plan from DB
async function getActivePlan(pool, planCode) {
  const sql = `SELECT code,name,price_cents,currency,paystack_plan_code
                 FROM public.subscription_plans
                WHERE code=$1 AND is_active IS TRUE`;
  const r = await pool.query(sql, [planCode]);
  return r.rows[0] || null;
}

// Activate/Upsert a user subscription
async function activateSubscription(pool, userId, planCode) {
  await pool.query(
    `
    INSERT INTO public.user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
    VALUES ($1, $2, 'active', NOW(), NOW(), '{}'::jsonb)
    ON CONFLICT (user_id) DO UPDATE
      SET plan_code = EXCLUDED.plan_code,
          status    = 'active',
          renewed_at= NOW()
    `,
    [userId, planCode]
  );
}

// Payment audit table (create if not exists)
async function ensurePaymentsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.payments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT,
      provider TEXT NOT NULL,
      reference TEXT UNIQUE,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      channel TEXT,
      plan_code TEXT,
      status TEXT NOT NULL,
      raw JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function recordPayment(pool, {
  user_id, reference, amount_cents, currency, channel, plan_code, status, raw
}) {
  await ensurePaymentsTable(pool);
  await pool.query(
    `
    INSERT INTO public.payments (user_id, provider, reference, amount_cents, currency, channel, plan_code, status, raw)
    VALUES ($1,'paystack',$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (reference) DO UPDATE
      SET status = EXCLUDED.status,
          raw    = EXCLUDED.raw
    `,
    [user_id || null, reference || null, amount_cents, currency, channel || null, plan_code || null, status || 'success', raw || {}]
  );
}

// Look up user by id (email for invoicing)
async function getUser(pool, userId) {
  const r = await pool.query(`SELECT id, email, name, paystack_customer_code FROM public.users WHERE id=$1`, [userId]);
  return r.rows[0] || null;
}

// --------------------------------------
// MIDDLEWARE: Auth (reuse existing one)
// --------------------------------------
const { authenticateToken } = require("../middleware/auth");

// --------------------------------------
// ENDPOINTS
// --------------------------------------

/**
 * POST /api/payments/checkout
 * Body: { plan_code: 'BASIC', channel?: 'mpesa'|'card' }
 * One-off payment (card or M-Pesa). Uses plan price from DB.
 */
router.post("/checkout", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const userId = req.user?.id;
    const userEmail = req.user?.email;
    if (!userId || !userEmail) return res.status(401).json({ error: "Unauthorized" });

    const { plan_code, channel } = req.body || {};
    if (!plan_code) return res.status(400).json({ error: "Missing 'plan_code'" });

    const plan = await getActivePlan(pool, plan_code);
    if (!plan) return res.status(404).json({ error: "Plan not found or inactive" });
    if (plan.currency !== "KES") return res.status(400).json({ error: "Plan currency must be KES" });

    const amount_minor = plan.price_cents; // KES*100 already
    const channels = channel === "mpesa" ? ["mobile_money"] : ["card", "mobile_money"];
    const callback_url = `${APP_PUBLIC_BASE}/billing`;

    const data = await initializeTransaction({
      email: userEmail,
      amount_minor,
      currency: "KES",
      channels,
      callback_url,
      metadata: { user_id: userId, plan_code },
    });

    res.json({ ok: true, authorization_url: data.authorization_url, reference: data.reference });
  } catch (err) {
    console.error("payments.checkout error:", err);
    res.status(500).json({ error: "Checkout failed", detail: err.message });
  }
});

/**
 * POST /api/payments/subscribe
 * Body: { plan_code: 'PREMIUM' }
 * For recurring **card** subscriptions via Paystack Plan.
 * Flow: we init a transaction with 'plan' and Paystack will handle the subscription
 * after the card is authorized. (M-Pesa auto-debit is limited; use one-off checkout for M-Pesa.)
 */
router.post("/subscribe", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const userId = req.user?.id;
    const userEmail = req.user?.email;
    const userName = req.user?.name || "";
    if (!userId || !userEmail) return res.status(401).json({ error: "Unauthorized" });

    const { plan_code } = req.body || {};
    if (!plan_code) return res.status(400).json({ error: "Missing 'plan_code'" });

    const plan = await getActivePlan(pool, plan_code);
    if (!plan || !plan.paystack_plan_code) {
      return res.status(400).json({ error: "Plan is not mapped to a Paystack Plan (paystack_plan_code missing)" });
    }

    // Optional: ensure Paystack customer exists (good hygiene)
    const [first, ...rest] = userName.split(" ");
    try { await ensurePaystackCustomer(userEmail, first || "", rest.join(" ")); } catch (e) {
      console.warn("ensurePaystackCustomer warning:", e.message);
    }

    const callback_url = `${APP_PUBLIC_BASE}/billing`;
    const data = await initializeTransaction({
      email: userEmail,
      amount_minor: plan.price_cents,     // Paystack ignores amount if plan is passed; safe to include
      currency: "KES",
      channels: ["card"],                 // recurring works best with card
      callback_url,
      plan: plan.paystack_plan_code,      // <— key line: this creates a subscription after auth
      metadata: { user_id: userId, plan_code },
    });

    res.json({ ok: true, authorization_url: data.authorization_url, reference: data.reference });
  } catch (err) {
    console.error("payments.subscribe error:", err);
    res.status(500).json({ error: "Subscribe failed", detail: err.message });
  }
});

/**
 * Paystack Webhook
 * Set in dashboard: POST /api/payments/paystack/webhook
 * IMPORTANT: This route must receive the **raw body** for signature verification.
 * We mount a raw parser here; see the index.js section.
 */
router.post(
  "/paystack/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const pool = getPool(req);

      const signature = req.headers["x-paystack-signature"];
      const rawStr = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body || {});
      if (!verifySignature(rawStr, signature)) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const event = JSON.parse(rawStr);

      // We handle both one-off charges and subscription renewals:
      // - event.event: "charge.success" (common)
      // Paystack also sends other events, but charge.success is enough to mark an invoice/renewal as paid.
      if (event?.event === "charge.success" && event?.data?.status === "success") {
        const md = event.data?.metadata || {};
        const userId = md.user_id || null;
        const planCode = md.plan_code || null;
        const reference = event.data?.reference;
        const amount_minor = event.data?.amount || 0;
        const currency = event.data?.currency || "KES";
        const channel = event.data?.channel || null;

        // If metadata is missing (e.g., renewal), try to infer from customer email via DB
        let userRow = null;
        if (!userId && event.data?.customer?.email) {
          const r = await pool.query(`SELECT id, email, name FROM public.users WHERE email=$1`, [event.data.customer.email]);
          userRow = r.rows[0] || null;
        } else if (userId) {
          userRow = await getUser(pool, userId);
        }

        if (userRow && planCode) {
          // Activate plan & record payment
          await activateSubscription(pool, userRow.id, planCode);
          await recordPayment(pool, {
            user_id: userRow.id,
            reference,
            amount_cents: amount_minor,
            currency,
            channel,
            plan_code: planCode,
            status: 'success',
            raw: event
          });

          // send invoice email (invoice-on-webhook)
          try {
            await sendEmail(
              userRow.email,
              "Saka360 Subscription Receipt",
              "subscription_invoice",
              {
                user_name: userRow.name || "there",
                plan_name: planCode,
                plan_code: planCode,
                amount_cents: amount_minor,
                currency: currency,
                invoice_number: reference || `PS-${Date.now()}`,
                issued_at: new Date().toISOString(),
                period_start: new Date().toISOString().slice(0,10), // basic placeholder
                period_end: "", // optional
                payment_link: `${APP_PUBLIC_BASE}/billing`
              }
            );
          } catch (e) {
            console.error("invoice email warning:", e.message);
          }
        } else {
          // Record anyway for audit
          await recordPayment(pool, {
            user_id: userRow?.id || null,
            reference,
            amount_cents: amount_minor,
            currency,
            channel,
            plan_code: planCode || null,
            status: 'success',
            raw: event
          });
        }
      }

      // Always 200 to stop retries
      res.json({ received: true });
    } catch (err) {
      console.error("paystack.webhook error:", err);
      res.status(200).json({ received: true, error: err.message });
    }
  }
);

module.exports = (app) => {
  app.use("/api/payments", router);
};
