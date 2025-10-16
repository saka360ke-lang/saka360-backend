// routes/affiliates.js
const express = require("express");
const { Pool } = require("pg");
const { sendEmail } = require("../utils/mailer");

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * POST /api/affiliates/payout
 * Sends an affiliate payout receipt email.
 * Body expects:
 * {
 *   "affiliate_email": "ally@example.com",
 *   "affiliate_name": "Ally Smith",
 *   "amount": "125",
 *   "currency": "USD",
 *   "payout_method": "Bank Transfer",
 *   "period_label": "September 2025",
 *   "payout_ref": "FT-123456" // optional (autogenerates if omitted)
 * }
 */
router.post("/payout", async (req, res) => {
  try {
    const {
      affiliate_email,
      affiliate_name,
      amount,
      currency = "USD",
      payout_method = "Bank Transfer",
      period_label = "Current Period",
      payout_ref
    } = req.body;

    if (!affiliate_email || !affiliate_name || !amount) {
      return res.status(400).json({ error: "affiliate_email, affiliate_name, amount are required" });
    }

    const ref = payout_ref || `FT-${Math.floor(Math.random() * 1_000_000)}`;

    // (Optional) store payout record
    try {
      await pool.query(
        `INSERT INTO affiliate_payouts (affiliate_email, affiliate_name, amount, currency, payout_method, payout_ref, period_label, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [affiliate_email, affiliate_name, amount, currency, payout_method, ref, period_label]
      );
    } catch (e) {
      console.error("affiliate_payouts insert warning:", e.message);
    }

    // Send payout receipt using payout.hbs
    await sendEmail(
      affiliate_email,
      "Saka360 Affiliate Payout Receipt",
      "payout",
      {
        affiliate_name,
        period_label,
        currency,
        amount,
        payout_method,
        payout_ref: ref,
        breakdown_url: "https://saka360.com/affiliates/payouts"
      }
    );

    res.json({ ok: true, message: "Payout email sent ✅", payout_ref: ref });
  } catch (err) {
    console.error("affiliates.payout error:", err);
    res.status(500).json({ ok: false, error: "Failed to send payout email", detail: err.message });
  }
});

/**
 * (Optional) Generate a shareable affiliate link for a user email
 * POST /api/affiliates/link
 * { "user_email":"ally@example.com" }
 */
router.post("/link", async (req, res) => {
  try {
    const { user_email } = req.body;
    if (!user_email) return res.status(400).json({ error: "user_email is required" });

    // very simple token (replace later with a real ID from DB)
    const token = Buffer.from(`${user_email}:${Date.now()}`).toString("base64url");
    const url = `https://saka360.com/?ref=${token}`;

    res.json({ ok: true, affiliate_link: url });
  } catch (err) {
    console.error("affiliates.link error:", err);
    res.status(500).json({ ok: false, error: "Failed to generate link", detail: err.message });
  }
});

module.exports = router;
