// routes/admin_email.js
const express = require("express");
const router = express.Router();
const path = require("path");

// We use HTTP Mailtrap sender + Handlebars renderer
const { sendMailHttp, renderTemplate } = require("../utils/mailer_https");

// Helpers
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
function asString(x) {
  if (x === undefined || x === null) return undefined;
  return String(x);
}
function parseUsdToCents(v) {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Math.round(v * 100);
  // string like "50.00"
  const n = Number(v);
  if (Number.isFinite(n)) return Math.round(n * 100);
  return undefined;
}
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

// Base template dir (can override with env)
const TEMPLATE_DIR = process.env.TEMPLATE_DIR || "templates";

// ----------------------------------------------------
// 1) VERIFICATION
// Body accepts:
//   to (required)
//   name (optional)
//   verification_link  OR verifyUrl (required)
// ----------------------------------------------------
router.post("/verification", async (req, res) => {
  try {
    const body = req.body || {};
    const to = asString(body.to);
    const name = asString(body.name) || "there";
    const verification_link = asString(firstNonEmpty(body.verification_link, body.verifyUrl));

    if (!to || !verification_link) {
      return res.status(400).json({ error: "Missing 'to' or 'verification_link'" });
    }

    const html = await renderTemplate(path.join(TEMPLATE_DIR, "emails/verification.hbs"), {
      name,
      verification_link
    });

    const text = `Hi ${name},

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

// ----------------------------------------------------
// 2) SUBSCRIPTION INVOICE
// Body accepts either canonical keys OR friendly aliases:
//   to (required)
//   plan_name | planName
//   plan_code | planCode
//   period_start | periodStart | invoiceDate
//   period_end   | periodEnd   | dueDate
//   amount_cents | amountCents | amountUSD | amountUsd
//   invoice_number | invoiceNumber
//   invoice_date   | invoiceDate
//   due_date       | dueDate
// ----------------------------------------------------
router.post("/invoice", async (req, res) => {
  try {
    const b = req.body || {};
    const to = asString(b.to);

    const plan_name  = asString(firstNonEmpty(b.plan_name, b.planName));
    const plan_code  = asString(firstNonEmpty(b.plan_code, b.planCode));

    const period_start = asString(firstNonEmpty(b.period_start, b.periodStart, b.invoiceDate));
    const period_end   = asString(firstNonEmpty(b.period_end, b.periodEnd, b.dueDate));

    // amount normalization
    let amount_cents = b.amount_cents;
    if (amount_cents === undefined) {
      amount_cents = parseUsdToCents(firstNonEmpty(b.amountUSD, b.amountUsd));
    }
    if (typeof amount_cents === "string" && /^\d+$/.test(amount_cents)) {
      amount_cents = Number(amount_cents);
    }

    const invoice_number = asString(firstNonEmpty(b.invoice_number, b.invoiceNumber));
    const invoice_date   = asString(firstNonEmpty(b.invoice_date, b.invoiceDate));
    const due_date       = asString(firstNonEmpty(b.due_date, b.dueDate));

    if (!to) {
      return res.status(400).json({ error: "Missing 'to'" });
    }
    if (!plan_name || !plan_code || !period_start || !period_end) {
      return res.status(400).json({
        error: "Missing required fields: plan_name/planName, plan_code/planCode, period_start/periodStart, period_end/periodEnd"
      });
    }
    if (amount_cents === undefined || !Number.isFinite(Number(amount_cents))) {
      return res.status(400).json({ error: "Missing or invalid amount (amount_cents or amountUSD)" });
    }

    const html = await renderTemplate(path.join(TEMPLATE_DIR, "emails/subscription_invoice.hbs"), {
      plan_name,
      plan_code,
      period_start,
      period_end,
      amount_cents: Number(amount_cents),
      amount_usd: (Number(amount_cents) / 100).toFixed(2),
      invoice_number: invoice_number || undefined,
      invoice_date:   invoice_date   || period_start,
      due_date:       due_date       || period_end
    });

    const text =
`Your Saka360 subscription invoice

Plan: ${plan_name} (${plan_code})
Period: ${period_start} → ${period_end}
Amount: $${(Number(amount_cents)/100).toFixed(2)}
Invoice: ${invoice_number || "-"}

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

// ----------------------------------------------------
// 3) AFFILIATE PAYOUT RECEIPT
// Accepts: to, affiliate_name, period_start, period_end, amount_cents|amountUSD, payout_id
// ----------------------------------------------------
router.post("/affiliate-payout", async (req, res) => {
  try {
    const b = req.body || {};
    const to = asString(b.to);
    const affiliate_name = asString(firstNonEmpty(b.affiliate_name, b.affiliateName)) || "Affiliate";
    const period_start = asString(firstNonEmpty(b.period_start, b.periodStart));
    const period_end   = asString(firstNonEmpty(b.period_end, b.periodEnd));
    let amount_cents = b.amount_cents ?? parseUsdToCents(firstNonEmpty(b.amountUSD, b.amountUsd));
    if (typeof amount_cents === "string" && /^\d+$/.test(amount_cents)) amount_cents = Number(amount_cents);
    const payout_id = asString(firstNonEmpty(b.payout_id, b.payoutId));

    if (!to || !period_start || !period_end || amount_cents === undefined) {
      return res.status(400).json({ error: "Missing required fields: to, period_start, period_end, amount" });
    }

    const html = await renderTemplate(path.join(TEMPLATE_DIR, "emails/affiliate_payout_receipt.hbs"), {
      affiliate_name,
      period_start,
      period_end,
      amount_cents: Number(amount_cents),
      amount_usd: (Number(amount_cents) / 100).toFixed(2),
      payout_id: payout_id || undefined
    });

    const text =
`Affiliate Payout Receipt

Affiliate: ${affiliate_name}
Period: ${period_start} → ${period_end}
Amount: $${(Number(amount_cents)/100).toFixed(2)}
Payout ID: ${payout_id || "-"}

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

// ----------------------------------------------------
// 4) MONTHLY REPORT DELIVERY
// Accepts: to, month_label, download_url (or downloadUrl), vehicle_count, document_count
// ----------------------------------------------------
router.post("/monthly-report", async (req, res) => {
  try {
    const b = req.body || {};
    const to = asString(b.to);
    const month_label = asString(firstNonEmpty(b.month_label, b.monthLabel)) || "This month";
    const download_url = asString(firstNonEmpty(b.download_url, b.downloadUrl));
    const vehicle_count = Number(firstNonEmpty(b.vehicle_count, b.vehicleCount, 0));
    const document_count = Number(firstNonEmpty(b.document_count, b.documentCount, 0));

    if (!to || !download_url) {
      return res.status(400).json({ error: "Missing 'to' or 'download_url/downloadUrl'" });
    }

    const html = await renderTemplate(path.join(TEMPLATE_DIR, "emails/monthly_report_delivery.hbs"), {
      month_label,
      download_url,
      vehicle_count: Number.isFinite(vehicle_count) ? vehicle_count : 0,
      document_count: Number.isFinite(document_count) ? document_count : 0
    });

    const text =
`Your Saka360 Monthly Report — ${month_label}

Vehicles: ${vehicle_count}
Documents: ${document_count}

Download: ${download_url}
`;

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
