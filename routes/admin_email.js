// routes/admin_email.js
const express = require("express");
const router = express.Router();
const { sendMailHttp } = require("../utils/mailer_https");

// OPTIONAL: protect with auth/admin later if you want
// const { authenticateToken, adminOnly } = require("../middleware/auth");

const DEFAULT_TO = process.env.ADMIN_TEST_EMAIL || "you@example.com";

/**
 * POST /api/admin/email/verification
 * Body: { to?: "addr", name?: "Hugu", verifyUrl?: "https://..." }
 */
router.post("/verification", async (req, res) => {
  try {
    const { to = DEFAULT_TO, name = "Saka360 User", verifyUrl } = req.body || {};
    const vars = {
      appName: "Saka360",
      userName: name,
      verifyUrl: verifyUrl || "https://app.saka360.com/verify?code=123456",
      supportEmail: "support@saka360.com",
    };

    const sent = await sendMailHttp({
      to,
      subject: "Verify your Saka360 account",
      template: "verification",
      variables: vars,
    });

    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: "Failed to send verification email", detail: err.message });
  }
});

/**
 * POST /api/admin/email/invoice
 * Body: { to?, invoiceNumber?, planName?, amountUSD?, invoiceDate?, dueDate? }
 */
router.post("/invoice", async (req, res) => {
  try {
    const {
      to = DEFAULT_TO,
      invoiceNumber = "INV-2025-0001",
      planName = "Premium",
      amountUSD = "50.00",
      invoiceDate = new Date().toISOString().slice(0, 10),
      dueDate = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
    } = req.body || {};

    const sent = await sendMailHttp({
      to,
      subject: `Your Saka360 invoice ${invoiceNumber}`,
      template: "subscription_invoice",
      variables: {
        appName: "Saka360",
        invoiceNumber,
        planName,
        amountUSD,
        invoiceDate,
        dueDate,
        billingEmail: "billing@saka360.com",
      },
    });

    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: "Failed to send invoice email", detail: err.message });
  }
});

/**
 * POST /api/admin/email/payout
 * Body: { to?, period?, amountUSD?, payoutId?, method? }
 */
router.post("/payout", async (req, res) => {
  try {
    const {
      to = DEFAULT_TO,
      period = "Oct 2025",
      amountUSD = "120.00",
      payoutId = "PAYOUT-ABC123",
      method = "M-Pesa",
    } = req.body || {};

    const sent = await sendMailHttp({
      to,
      subject: `Saka360 Affiliate Payout Receipt – ${period}`,
      template: "affiliate_payout_receipt",
      variables: {
        appName: "Saka360",
        period,
        amountUSD,
        payoutId,
        method,
        supportEmail: "affiliates@saka360.com",
      },
    });

    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: "Failed to send payout email", detail: err.message });
  }
});

/**
 * POST /api/admin/email/monthly-report
 * Body: { to?, month?, link? }
 */
router.post("/monthly-report", async (req, res) => {
  try {
    const {
      to = DEFAULT_TO,
      month = "October 2025",
      link = "https://app.saka360.com/reports/download?id=demo",
    } = req.body || {};

    const sent = await sendMailHttp({
      to,
      subject: `Your Saka360 monthly report – ${month}`,
      template: "monthly_report_delivery",
      variables: {
        appName: "Saka360",
        month,
        reportLink: link,
        supportEmail: "support@saka360.com",
      },
    });

    res.json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: "Failed to send monthly report email", detail: err.message });
  }
});

module.exports = router;
