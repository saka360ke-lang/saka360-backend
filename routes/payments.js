// routes/payments.js
const express = require("express");
const fetch = require("node-fetch"); // ensure "node-fetch" is in package.json
const { authenticateToken } = require("../middleware/auth");
const { rulesFor, getUserPlan } = require("../middleware/planGuard");

const router = express.Router();

function getPool(req) { return req.app.get("pool"); }

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY; // set in Render
const PAYSTACK_API_BASE   = process.env.PAYSTACK_API_BASE || "https://api.paystack.co";

/**
 * POST /api/payments/start
 * Body: { plan_code: "BASIC" }
 * - Looks up subscription_plans row by code
 * - Initializes a Paystack transaction tied to that plan
 * - Returns { authorization_url, reference }
 */
router.post("/start", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { plan_code } = req.body || {};
    if (!plan_code) return res.status(400).json({ error: "Missing plan_code" });

    // load plan (normalize shape)
    const colQ = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='subscription_plans'`
    );
    const cols = new Set(colQ.rows.map(r => r.column_name));

    const planQ = await pool.query(
      `SELECT * FROM public.subscription_plans WHERE UPPER(code)=UPPER($1) OR UPPER(name)=UPPER($1) LIMIT 1`,
      [plan_code]
    );
    const plan = planQ.rows[0];
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const price_cents =
      (cols.has("price_cents") && plan.price_cents != null)
        ? Number(plan.price_cents)
        : (cols.has("price_amount") && plan.price_amount != null)
          ? Math.round(Number(plan.price_amount) * 100)
          : 0;

    const currency = plan.currency || plan.price_currency || "KES";
    const paystackPlan = cols.has("paystack_plan_code") ? plan.paystack_plan_code : null;

    if (!paystackPlan) {
      return res.status(400).json({ error: "Plan is not linked to a Paystack plan code yet" });
    }
    if (!PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: "PAYSTACK_SECRET_KEY missing in env" });
    }

    // Initialize a Paystack transaction
    const initRes = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: userEmail,
        amount: price_cents,           // smallest currency unit (KES cents)
        currency,
        plan: paystackPlan,            // ties this transaction to the recurring plan
        metadata: {
          user_id: userId,
          plan_code,
          app: "Saka360"
        },
        callback_url: process.env.PAYSTACK_CALLBACK_URL || "https://app.saka360.com/billing/callback"
      })
    });

    const initJson = await initRes.json();
    if (!initRes.ok || !initJson.status) {
      return res.status(400).json({ error: "Paystack init failed", detail: initJson });
    }

    // Optionally record a pending subscription attempt
    try {
      await pool.query(
        `INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, meta)
         VALUES ($1,$2,'pending',NOW(),$3)`,
        [userId, plan_code, initJson.data]
      );
    } catch (e) {
      console.error("payments.start warn insert user_subscriptions:", e.message);
    }

    res.json({
      ok: true,
      authorization_url: initJson.data.authorization_url,
      access_code: initJson.data.access_code,
      reference: initJson.data.reference
    });
  } catch (e) {
    console.error("payments.start error:", e);
    res.status(500).json({ error: "Failed to start payment", detail: e.message });
  }
});

/**
 * Paystack webhook (optional stub for now)
 * Set PAYSTACK_WEBHOOK_SECRET if you want to verify signatures later.
 */
router.post("/webhook", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    // Optionally verify signature:
    // const sig = req.headers["x-paystack-signature"];
    // const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
    // if (!sig || !secret) { ...verify... }

    const event = JSON.parse(req.body.toString("utf8"));
    console.log("[paystack webhook] event:", event?.event);

    // TODO: on "charge.success" tied to a plan, mark user_subscriptions row as active:
    // const reference = event.data?.reference;
    // const email = event.data?.customer?.email;
    // const metadata = event.data?.metadata || {};
    // const plan_code = metadata?.plan_code;
    // UPDATE user_subscriptions SET status='active', renewed_at=NOW() WHERE user_id=... AND plan_code=...

    res.json({ received: true });
  } catch (e) {
    console.error("paystack.webhook error:", e);
    res.status(500).json({ error: "webhook error" });
  }
});

module.exports = router;
