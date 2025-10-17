// routes/payments.js
const express = require("express");
const { Pool } = require("pg");
const { sendEmail } = require("../utils/mailer");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * POST /api/payments/confirm
 * Sends a subscription invoice email after you confirm a payment in your app.
 * Body:
 * {
 *   "user_email": "jane@example.com",
 *   "user_name": "Jane Doe",
 *   "plan_name": "Premium",
 *   "amount": "20000",
 *   "currency": "KES",
 *   "period_start": "2025-10-01",
 *   "period_end": "2026-09-30",
 *   "invoice_number": "INV-000123",   // optional
 *   "payment_link": "https://saka360.com/pay/INV-000123" // optional
 * }
 */
router.post("/confirm", async (req, res) => {
  try {
    const {
      user_email,
      user_name,
      plan_name,
      amount,
      currency = "KES",
      period_start,
      period_end,
      invoice_number,
      payment_link = "https://saka360.com/dashboard",
    } = req.body || {};

    if (!user_email || !user_name || !plan_name || !amount) {
      return res
        .status(400)
        .json({ error: "user_email, user_name, plan_name, amount are required" });
    }

    const invNo = invoice_number || `INV-${Date.now()}`;

    // (Optional) store a lightweight payment record (non-blocking if it fails)
    try {
      await pool.query(
        `INSERT INTO payments (user_email, plan_name, amount, currency, invoice_number, period_start, period_end, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [user_email, plan_name, amount, currency, invNo, period_start || null, period_end || null]
      );
    } catch (e) {
      console.error("payments insert warning:", e.message);
    }

    // Send invoice email using templates/invoice.hbs
    await sendEmail(
      user_email,
      "Your Saka360 Subscription Invoice",
      "invoice",
      {
        user_name,
        plan_name,
        invoice_number: invNo,
        date: new Date().toLocaleDateString(),
        period_start: period_start || "—",
        period_end: period_end || "—",
        currency,
        amount,
        total_due: amount,
        payment_link,
      }
    );

    res.json({ ok: true, message: "Invoice email sent ✅", invoice_number: invNo });
  } catch (err) {
    console.error("payments.confirm error:", err);
    res.status(500).json({ ok: false, error: "Failed to send invoice email", detail: err.message });
  }
});

/**
 * POST /api/payments/test
 * Body: { "to":"you@example.com" }
 * Sends a sample invoice email (no DB).
 */
router.post("/test", async (req, res) => {
  try {
    const to = req.body?.to;
    if (!to) return res.status(400).json({ error: "Provide 'to' email in body" });

    await sendEmail(
      to,
      "Sample Saka360 Invoice (Test)",
      "invoice",
      {
        user_name: "Sample User",
        plan_name: "Basic (Annual)",
        invoice_number: `INV-${Date.now()}`,
        date: new Date().toLocaleDateString(),
        period_start: "2025-10-01",
        period_end: "2026-09-30",
        currency: "KES",
        amount: "20,000",
        total_due: "20,000",
        payment_link: "https://saka360.com/dashboard",
      }
    );

    res.json({ ok: true, message: "Test invoice sent ✅", to });
  } catch (err) {
    console.error("payments.test error:", err);
    res.status(500).json({ ok: false, error: "Failed to send test invoice", detail: err.message });
  }
});

module.exports = router;
