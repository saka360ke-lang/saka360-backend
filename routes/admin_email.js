// routes/admin_email.js
const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const { sendMailHttp, renderTemplate } = require("../utils/mailer_https");

// Version flag so we can verify on /_diag
const ADMIN_EMAIL_ROUTE_VERSION = "v2-templates-aliases-2025-11-06";

const TEMPLATE_DIR = process.env.TEMPLATE_DIR || "templates";

// ---- helpers ----
function s(x) {
  if (x === undefined || x === null) return undefined;
  return String(x);
}
function first(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}
function usdToCents(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Math.round(v * 100);
  const n = Number(v);
  if (Number.isFinite(n)) return Math.round(n * 100);
  return undefined;
}
function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

// ---- DIAG: confirm correct file + templates are present ----
router.get("/_diag", (req, res) => {
  const files = [
    "emails/verification.hbs",
    "emails/subscription_invoice.hbs",
    "emails/affiliate_payout_receipt.hbs",
    "emails/monthly_report_delivery.hbs",
  ];
  const exists = files.map(f => ({
    file: f,
    path: path.join(TEMPLATE_DIR, f),
    exists: fs.existsSync(path.join(TEMPLATE_DIR, f))
  }));
  return res.json({
    ok: true,
    version: ADMIN_EMAIL_ROUTE_VERSION,
    template_dir: TEMPLATE_DIR,
    templates: exists
  });
});

// 1) Account verification
// Accepts: to (required), name, verification_link OR verifyUrl (required)
router.post("/verification", async (req, res) => {
  try {
    const b = req.body || {};
    const to = s(b.to);
    const name = s(b.name) || "there";
    const verification_link = s(first(b.verification_link, b.verifyUrl));

    if (!to || !verification_link) {
      return res.status(400).json({ error: "Missing 'to' or 'verification_link'" });
    }

    const html = await renderTemplate(
      path.join(TEMPLATE_DIR, "emails/verification.hbs"),
      { name, verification_link }
    );
    const text =
`Hi ${name},

Please verify your Saka360 account:

${verification_link}

If you didn’t request this, you can ignore this message.
— Saka360`;

    const sent = await sendMailHttp({
      to,
      subject: "Verify your Saka360 account",
      html,
      text
    });
    res.json({ ok: true, sent });
  } catch (err) {
    console.error("admin_email.verification error:", err);
    res.status(500).json({ error: "Failed to send verification email", detail: err.message });
  }
});

// 2) Subscription invoice
// Accepts aliases:
//   to
//   plan_name | planName
//   plan_code | planCode
//   period_start | periodStart | invoiceDate
//   period_end   | periodEnd   | dueDate
//   amount_cents | amountCents | amountUSD | amountUsd
//   invoice_number | invoiceNumber
//   invoice_date   | invoiceDate
//   due_date       | dueDate
router.post("/invoice", async (req, res) => {
  try {
    const b = req.body || {};
    const to = s(b.to);

    const plan_name = s(first(b.plan_name, b.planName));
    const plan_code = s(first(b.plan_code, b.planCode));
    const period_start = s(first(b.period_start, b.periodStart, b.invoiceDate));
    const period_end   = s(first(b.period_end, b.periodEnd, b.dueDate));

    let amount_cents = b.amount_cents ?? b.amountCents;
    if (amount_cents === undefined) {
      amount_cents = usdToCents(first(b.amountUSD, b.amountUsd));
    }
    if (typeof amount_cents === "string" && /^\d+$/.test(amount_cents)) {
      amount_cents = Number(amount_cents);
    }

    const invoice_number = s(first(b.invoice_number, b.invoiceNumber)) || "-";
    const invoice_date   = s(first(b.invoice_date, b.invoiceDate)) || period_start;
    const due_date       = s(first(b.due_date, b.dueDate)) || period_end;

    if (!to || !plan_name || !plan_code || !period_start || !period_end) {
      return res.status(400).json({
        error: "Missing required fields: to, plan_name/planName, plan_code/planCode, period_start/periodStart, period_end/periodEnd"
      });
    }
    if (amount_cents === undefined || !Number.isFinite(Number(amount_cents))) {
      return res.status(400).json({ error: "Missing or invalid amount (amount_cents/amountCents or amountUSD)" });
    }

    const html = await renderTemplate(
      path.join(TEMPLATE_DIR, "emails/subscription_invoice.hbs"),
      {
        plan_name,
        plan_code,
        period_start,
        period_end,
        amount_cents: Number(amount_cents),
        amount_usd: (Number(amount_cents) / 100).toFixed(2),
        invoice_number,
        invoice_date,
        due_date
      }
    );
    const text =
`Your Saka360 subscription invoice

Plan: ${plan_name} (${plan_code})
Period: ${period_start} → ${period_end}
Amount: $${(Number(amount_cents)/100).toFixed(2)}
Invoice: ${invoice_number}

Thank you for your business.`;

    const sent = await sendMailHttp({
      to,
      subject: `Invoice for ${plan_name} (${plan_code})`,
      html,
      text
    });
    res.json({ ok: true, sent });
  } catch (err) {
    console.error("admin_email.invoice error:", err);
    res.status(500).json({ error: "Failed to send invoice email", detail: err.message });
  }
});

// 3) Affiliate payout
// Accepts: to, affiliate_name|affiliateName, period_start|periodStart, period_end|periodEnd,
//          amount_cents|amountCents|amountUSD, payout_id|payoutId
router.post("/affiliate-payout", async (req, res) => {
  try {
    const b = req.body || {};
    const to = s(b.to);
    const affiliate_name = s(first(b.affiliate_name, b.affiliateName)) || "Affiliate";
    const period_start = s(first(b.period_start, b.periodStart));
    const period_end   = s(first(b.period_end, b.periodEnd));

    let amount_cents = b.amount_cents ?? b.amountCents;
    if (amount_cents === undefined) {
      amount_cents = usdToCents(first(b.amountUSD, b.amountUsd));
    }
    if (typeof amount_cents === "string" && /^\d+$/.test(amount_cents)) amount_cents = Number(amount_cents);

    const payout_id = s(first(b.payout_id, b.payoutId)) || "-";

    if (!to || !period_start || !period_end || amount_cents === undefined) {
      return res.status(400).json({ error: "Missing required fields: to, period_start, period_end, amount" });
    }

    const html = await renderTemplate(
      path.join(TEMPLATE_DIR, "emails/affiliate_payout_receipt.hbs"),
      {
        affiliate_name,
        period_start,
        period_end,
        amount_cents: Number(amount_cents),
        amount_usd: (Number(amount_cents) / 100).toFixed(2),
        payout_id
      }
    );
    const text =
`Affiliate Payout Receipt

Affiliate: ${affiliate_name}
Period: ${period_start} → ${period_end}
Amount: $${(Number(amount_cents)/100).toFixed(2)}
Payout ID: ${payout_id}

Thank you for partnering with Saka360.`;

    const sent = await sendMailHttp({
      to,
      subject: `Affiliate Payout — ${period_start} to ${period_end}`,
      html,
      text
    });
    res.json({ ok: true, sent });
  } catch (err) {
    console.error("admin_email.affiliate-payout error:", err);
    res.status(500).json({ error: "Failed to send affiliate payout email", detail: err.message });
  }
});

// 4) Monthly report delivery
// Accepts: to, month_label|monthLabel, download_url|downloadUrl, vehicle_count|vehicleCount, document_count|documentCount
router.post("/monthly-report", async (req, res) => {
  try {
    const b = req.body || {};
    const to = s(b.to);
    const month_label = s(first(b.month_label, b.monthLabel)) || "This month";
    const download_url = s(first(b.download_url, b.downloadUrl));
    const vehicle_count = toInt(first(b.vehicle_count, b.vehicleCount, 0)) ?? 0;
    const document_count = toInt(first(b.document_count, b.documentCount, 0)) ?? 0;

    if (!to || !download_url) {
      return res.status(400).json({ error: "Missing 'to' or 'download_url/downloadUrl'" });
    }

    const html = await renderTemplate(
      path.join(TEMPLATE_DIR, "emails/monthly_report_delivery.hbs"),
      { month_label, download_url, vehicle_count, document_count }
    );
    const text =
`Your Saka360 Monthly Report — ${month_label}

Vehicles: ${vehicle_count}
Documents: ${document_count}

Download: ${download_url}`;

    const sent = await sendMailHttp({
      to,
      subject: `Your Saka360 Monthly Report — ${month_label}`,
      html,
      text
    });
    res.json({ ok: true, sent });
  } catch (err) {
    console.error("admin_email.monthly-report error:", err);
    res.status(500).json({ error: "Failed to send monthly report email", detail: err.message });
  }
});

module.exports = router;
