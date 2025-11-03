// utils/mailer.js
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const handlebars = require("handlebars");

// Transport
let transporter = null;
function getTransport() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    // Dev: log-only transport
    transporter = {
      sendMail: async (opts) => {
        console.log("[mailer:dev] Would send mail:", {
          to: opts.to, subject: opts.subject, htmlPreview: (opts.html || "").slice(0, 200) + "..."
        });
        return { messageId: "dev-preview" };
      },
    };
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function verifySmtp() {
  const t = getTransport();
  if (t.verify) return t.verify();
  return true;
}

// ---- Template loader with inline fallbacks ----
function compileTemplate(name) {
  const file = path.join(__dirname, "..", "templates", "emails", `${name}.hbs`);
  if (fs.existsSync(file)) {
    const src = fs.readFileSync(file, "utf8");
    return handlebars.compile(src);
  }

  // Inline fallbacks
  const inline = {
    verification: `
      <h2>Verify your Saka360 account</h2>
      <p>Hi {{user_name}},</p>
      <p>Click the link below to verify your account:</p>
      <p><a href="{{verification_link}}">Verify Account</a></p>
      <p>If you didn’t request this, you can ignore this email.</p>
    `,
    subscription_invoice: `
      <h2>Saka360 Invoice</h2>
      <p>Hi {{user_name}},</p>
      <p>Plan: <strong>{{plan_name}} ({{plan_code}})</strong></p>
      <p>Amount: <strong>{{currency}} {{amount_dollars}}</strong></p>
      <p>Invoice #: {{invoice_number}} • Issued: {{issued_at}}</p>
      <p>Period: {{period_start}} → {{period_end}}</p>
      {{#if payment_link}}
        <p><a href="{{payment_link}}">Pay now</a></p>
      {{/if}}
    `,
    affiliate_payout_receipt: `
      <h2>Affiliate Payout Receipt</h2>
      <p>Hi {{partner_name}},</p>
      <p>Payout ID: {{payout_id}}</p>
      <p>Amount: <strong>{{currency}} {{amount_dollars}}</strong></p>
      <p>Method: {{payment_method}}{{#if reference}} • Ref: {{reference}}{{/if}}</p>
      <p>Period: {{period_start}} → {{period_end}}</p>
    `,
    monthly_report_delivery: `
      <h2>Your monthly Saka360 report</h2>
      <p>Hi {{user_name}},</p>
      <p>{{month_label}} summary:</p>
      <ul>
        <li>Total vehicles: {{total_vehicles}}</li>
        <li>Services logged: {{services_count}}</li>
        <li>Documents uploaded: {{documents_count}}</li>
        <li>Upcoming renewals: {{upcoming_count}}</li>
      </ul>
      {{#if report_url}}
        <p>Download your report: <a href="{{report_url}}">Report PDF</a></p>
      {{/if}}
    `,
  };

  const tpl = inline[name];
  if (!tpl) throw new Error(`Template '${name}' not found (no file, no fallback).`);
  return handlebars.compile(tpl);
}

function centsToDollars(cents, currency = "USD") {
  const v = (Number(cents || 0) / 100).toFixed(2);
  return v;
}

async function sendEmail(to, subject, templateName, data = {}) {
  const t = getTransport();
  const template = compileTemplate(templateName);

  // Enrich data
  const ctx = { ...data };
  if (templateName === "subscription_invoice" || templateName === "affiliate_payout_receipt") {
    ctx.amount_dollars = centsToDollars(ctx.amount_cents, ctx.currency);
  }

  const html = template(ctx);
  return t.sendMail({
    to,
    from: process.env.SMTP_FROM || "Saka360 <no-reply@saka360.com>",
    subject,
    html,
  });
}

module.exports = { verifySmtp, sendEmail };
