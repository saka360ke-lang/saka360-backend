// utils/mailer.js
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const handlebars = require("handlebars");

// ---- Transport ----
function buildTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn("[mailer] SMTP not configured – missing host/user/pass");
    return null; // dev-mode: we will console.log instead
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE || "false") === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

const transport = buildTransport();

// ---- Template Loader (with cache) ----
const TEMPLATE_DIR = path.join(process.cwd(), "templates", "emails");
const cache = new Map();

function loadTemplate(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(TEMPLATE_DIR, `${name}.hbs`);
  const src = fs.readFileSync(file, "utf8");
  const compiled = handlebars.compile(src, { noEscape: true });
  cache.set(name, compiled);
  return compiled;
}

// Simple helpers
handlebars.registerHelper("formatCents", (cents, currency="USD") => {
  const v = Number(cents || 0) / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(v);
});
handlebars.registerHelper("formatDate", (iso) => {
  try { return new Date(iso).toLocaleString("en-KE"); } catch { return iso; }
});

// ---- Public API ----
async function verifySmtp() {
  if (!transport) return false;
  await transport.verify();
  return true;
}

/**
 * sendEmail(to, subject, templateName, context)
 */
async function sendEmail(to, subject, templateName, ctx = {}) {
  const compiled = loadTemplate(templateName);
  const html = compiled(ctx);

  if (!transport) {
    console.log("[mailer:dev] Would send mail:", { to, subject, templateName, ctx });
    return { dev: true };
  }

  const from = process.env.SMTP_FROM || `"Saka360" <no-reply@saka360.com>`;
  const info = await transport.sendMail({ from, to, subject, html });
  return { id: info.messageId };
}

module.exports = { sendEmail, verifySmtp };
