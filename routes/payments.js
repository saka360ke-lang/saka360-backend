// routes/payments.js
const express = require("express");
const { Pool } = require("pg");
const { sendEmail } = require("../utils/mailer");

const router = express.Router();

// Use your same DB URL from Render env
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * POST /api/payments/confirm
 * Sends a subscription invoice email after you confirm a payment in your app.
 * Body expects:
 * {
 *   "user_email": "jane@example.com",
 *   "user_name": "Jane Doe",
 *   "plan_name": "Premium",
 *   "amount": "50",
 *   "currency": "USD",
 *   "period_start": "2025-10-01",
 *   "period_end": "2026-09-30",
 *   "invoice_number": "INV-000123",   // optional (autogenerates if omitted)
 *   "payment_link": "https://saka360.com/dashboard" // optional
 * }
 */
router.post("/confirm", async (req, res) => {
  try {
    const {
      user_email,
      user_name,
      plan_name,
      amount,
      currency = "USD",
      period_start,
      period_end,
      invoice_number,
      payment_link = "https://saka360.com/dashboard"
    } = req.body;

    if (!user_email || !user_name || !plan_name || !amount) {
      return res.status(400).json({ error: "user_email, user_name, plan_name, amount are required" });
    }

    const invNo = invoice_number || `INV-${Date.now()}`;

    // (Optional) save a lightweight payment record
    try {
      await pool.query(
        `INSERT INTO payments (user_email, plan_name, amount, currency, invoice_number, period_start, period_end, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [user_email, plan_name, amount, currency, invNo, period_start || null, period_end || null]
      );
    } catch (e) {
      // non-fatal for email sending; just log
      console.error("payments insert warning:", e.message);
    }

    // Send invoice email using invoice.hbs
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
        payment_link
      }
    );

    res.json({ ok: true, message: "Invoice email sent ✅", invoice_number: invNo });
  } catch (err) {
    console.error("payments.confirm error:", err);
    res.status(500).json({ ok: false, error: "Failed to send invoice email", detail: err.message });
  }
});

/**
 * (Optional) Simple test to send yourself a sample invoice without touching DB.
 * POST /api/payments/test
 * Body:
 * { "to":"you@example.com" }
 */
router.post("/test", async (req, res) => {
  try {
    const to = req.body.to;
    if (!to) return res.status(400).json({ error: "Provide 'to' email in body" });

    await sendEmail(
      to,
      "Sample Saka360 Invoice (Test)",
      "invoice",
      {
        user_name: "Sample User",
        plan_name: "Basic",
        invoice_number: `INV-${Date.now()}`,
        date: new Date().toLocaleDateString(),
        period_start: "2025-10-01",
        period_end: "2026-03-31",
        currency: "USD",
        amount: "30",
        total_due: "30",
        payment_link: "https://saka360.com/dashboard"
      }
    );

    res.json({ ok: true, message: "Test invoice sent ✅", to });
  } catch (err) {
    console.error("payments.test error:", err);
    res.status(500).json({ ok: false, error: "Failed to send test invoice", detail: err.message });
  }
});

module.exports = router;
