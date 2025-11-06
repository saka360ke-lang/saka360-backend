// routes/adminEmails.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const Handlebars = require("handlebars");

// We use your existing utils/mailer abstraction so MAIL_MODE=http|smtp keeps working
const { sendEmail } = require("../utils/mailer");

const router = express.Router();

// Where templates live
const TEMPLATE_DIR = process.env.TEMPLATE_DIR || "templates";

// Simple cache so we don’t re-read/compile on every request
const templateCache = new Map();

function compileTemplate(relPath) {
  const fullPath = path.join(TEMPLATE_DIR, relPath);
  const key = fullPath;
  if (templateCache.has(key)) return templateCache.get(key);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Template not found at ${fullPath}`);
  }
  const source = fs.readFileSync(fullPath, "utf8");
  const tpl = Handlebars.compile(source);
  templateCache.set(key, tpl);
  return tpl;
}

async function render(relPath, data) {
  const tpl = compileTemplate(relPath);
  return tpl(data || {});
}

function pick(obj = {}, keys = []) {
  const out = {};
  keys.forEach(k => {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  });
  return out;
}

// --- Diagnostics: which templates exist?
router.get("/_diag", (req, res) => {
  const files = [
    "emails/verification.hbs",
    "emails/subscription_invoice.hbs",
    "emails/affiliate_payout_receipt.hbs",
    "emails/monthly_report_delivery.hbs",
  ];
  const payload = files.map(file => {
    const p = path.join(TEMPLATE_DIR, file);
    return { file, path: p, exists: fs.existsSync(p) };
  });
  return res.json({
    ok: true,
    version: "v2-templates-aliases-2025-11-06",
    template_dir: TEMPLATE_DIR,
    templates: payload,
  });
});

// --- 1) Account verification
// Accepts either snake_case or camelCase keys (verifyUrl or verification_link)
router.post("/verification", async (req, res) => {
  try {
    const to = req.body?.to;
    const name = req.body?.name || "there";
    const verification_link = req.body?.verification_link || req.body?.verifyUrl || req.body?.verifyURL;

    if (!to || !verification_link) {
      return res.status(400).json({ error: "Missing 'to' or 'verification_link'" });
    }

    const html = await render("emails/verification.hbs", { name, verification_link });
    const subject = "Verify your Saka360 account";
    const result = await sendEmail(to, subject, html);

    return res.json({ ok: true, sent: pick(result, ["messageId", "id"]) });
  } catch (err) {
    console.error("verification email error:", err);
    return res.status(500).json({ error: "Failed to send verification email", detail: err.message });
  }
});

// --- 2) Subscription invoice
// Accept both: {plan_name, plan_code, period_start, period_end, invoice_number, amount_usd, invoice_date, due_date}
// and camelCase aliases: planName, planCode, periodStart, periodEnd, invoiceNumber, amountUSD, invoiceDate, dueDate
router.post("/invoice", async (req, res) => {
  try {
    const body = req.body || {};
    const to            = body.to;
    const plan_name     = body.plan_name     ?? body.planName;
    const plan_code     = body.plan_code     ?? body.planCode;
    const period_start  = body.period_start  ?? body.periodStart;
    const period_end    = body.period_end    ?? body.periodEnd;
    const invoice_number= body.invoice_number?? body.invoiceNumber;
    const amount_usd    = body.amount_usd    ?? body.amountUSD;
    const invoice_date  = body.invoice_date  ?? body.invoiceDate;
    const due_date      = body.due_date      ?? body.dueDate;

    if (!to || !plan_name || !plan_code || !period_start || !period_end) {
      return res.status(400).json({
        error: "Missing required fields: to, plan_name, plan_code, period_start, period_end",
      });
    }

    const html = await render("emails/subscription_invoice.hbs", {
      plan_name, plan_code, period_start, period_end,
      invoice_number: invoice_number || "INV-0000",
      amount_usd: amount_usd || "0.00",
      invoice_date: invoice_date || new Date().toISOString().slice(0,10),
      due_date: due_date || new Date().toISOString().slice(0,10),
    });
    const subject = `Your Saka360 invoice — ${plan_name}`;
    const result = await sendEmail(to, subject, html);

    return res.json({ ok: true, sent: pick(result, ["messageId", "id"]) });
  } catch (err) {
    console.error("invoice email error:", err);
    return res.status(500).json({ error: "Failed to send invoice email", detail: err.message });
  }
});

// --- 3) Affiliate payout receipt
// Accept snake_case and camelCase
router.post("/affiliate-payout", async (req, res) => {
  try {
    const body = req.body || {};
    const to            = body.to;
    const affiliate_name= body.affiliate_name ?? body.affiliateName ?? "Affiliate";
    const period_start  = body.period_start   ?? body.periodStart;
    const period_end    = body.period_end     ?? body.periodEnd;
    const amount_usd    = body.amount_usd     ?? body.amountUSD     ?? "0.00";
    const payout_id     = body.payout_id      ?? body.payoutId      ?? "PAYOUT-0000";

    if (!to || !period_start || !period_end) {
      return res.status(400).json({
        error: "Missing required fields: to, period_start, period_end",
      });
    }

    const html = await render("emails/affiliate_payout_receipt.hbs", {
      affiliate_name, period_start, period_end, amount_usd, payout_id
    });
    const subject = "Your Saka360 affiliate payout receipt";
    const result = await sendEmail(to, subject, html);

    return res.json({ ok: true, sent: pick(result, ["messageId", "id"]) });
  } catch (err) {
    console.error("affiliate payout email error:", err);
    return res.status(500).json({ error: "Failed to send affiliate payout email", detail: err.message });
  }
});

// --- 4) Monthly report delivery
// Accept snake_case and camelCase
router.post("/monthly-report", async (req, res) => {
  try {
    const body = req.body || {};
    const to              = body.to;
    const month_label     = body.month_label     ?? body.monthLabel ?? "This month";
    const download_url    = body.download_url    ?? body.downloadUrl ?? "#";
    const vehicle_count   = body.vehicle_count   ?? body.vehicleCount ?? 0;
    const document_count  = body.document_count  ?? body.documentCount ?? 0;

    if (!to) return res.status(400).json({ error: "Missing 'to'" });

    const html = await render("emails/monthly_report_delivery.hbs", {
      month_label, download_url, vehicle_count, document_count
    });
    const subject = `Your Saka360 monthly report — ${month_label}`;
    const result = await sendEmail(to, subject, html);

    return res.json({ ok: true, sent: pick(result, ["messageId", "id"]) });
  } catch (err) {
    console.error("monthly report email error:", err);
    return res.status(500).json({ error: "Failed to send monthly report email", detail: err.message });
  }
});

// --- 5) Send all four (handy test)
router.post("/test-all", async (req, res) => {
  try {
    const to = req.body?.to || process.env.MAIL_TEST_TO;
    if (!to) return res.status(400).json({ error: "Provide 'to' in body or set MAIL_TEST_TO" });

    const results = [];

    // 1) verification
    {
      const html = await render("emails/verification.hbs", {
        name: "Hugu",
        verification_link: "https://app.saka360.com/verify?code=123456",
      });
      results.push(await sendEmail(to, "Verify your Saka360 account", html));
    }

    // 2) invoice
    {
      const html = await render("emails/subscription_invoice.hbs", {
        plan_name: "Premium",
        plan_code: "PREMIUM",
        period_start: "2025-11-01",
        period_end: "2025-11-30",
        invoice_number: "INV-TEST-001",
        amount_usd: "50.00",
        invoice_date: "2025-11-06",
        due_date: "2025-11-13",
      });
      results.push(await sendEmail(to, "Your Saka360 invoice — Premium", html));
    }

    // 3) affiliate payout
    {
      const html = await render("emails/affiliate_payout_receipt.hbs", {
        affiliate_name: "John Driver",
        period_start: "2025-10-01",
        period_end: "2025-10-31",
        amount_usd: "120.50",
        payout_id: "PAYOUT-2025-10-31-01",
      });
      results.push(await sendEmail(to, "Affiliate payout receipt", html));
    }

    // 4) monthly report
    {
      const html = await render("emails/monthly_report_delivery.hbs", {
        month_label: "October 2025",
        download_url: "https://app.saka360.com/reports/2025-10/download",
        vehicle_count: 7,
        document_count: 22,
      });
      results.push(await sendEmail(to, "Your Saka360 monthly report — October 2025", html));
    }

    return res.json({
      ok: true,
      sent: results.map(r => ({ messageId: r?.messageId || r?.id || "ok" })),
    });
  } catch (err) {
    console.error("test-all email error:", err);
    return res.status(500).json({ error: "Failed to send test-all emails", detail: err.message });
  }
});

module.exports = router;
