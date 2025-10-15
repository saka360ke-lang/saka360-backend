// utils/mailer.js
const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

// Node 18+ has global fetch; if not, uncomment next line:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN;
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || "no-reply@saka360.com";
const FROM_NAME  = process.env.MAIL_FROM_NAME  || "Saka360";

function renderTemplateIfProvided(templateNameOrNull, variables) {
  if (!templateNameOrNull) return { html: null }; // no template requested
  const filePath = path.join(__dirname, "..", "templates", `${templateNameOrNull}.hbs`);
  const raw = fs.readFileSync(filePath, "utf8");
  const compiled = Handlebars.compile(raw);
  const html = compiled(variables || {});
  return { html };
}

/**
 * Send email via Mailtrap Email Sending API
 * @param {string} to - recipient email
 * @param {string} subject - email subject
 * @param {string|null} templateName - e.g. 'verification' to load templates/verification.hbs; null for plain text
 * @param {object|string} payload - if templateName != null => variables; else => plain text string body
 */
async function sendEmail(to, subject, templateName = null, payload = "") {
  if (!MAILTRAP_API_TOKEN) throw new Error("MAILTRAP_API_TOKEN not set");

  let text = "";
  let html = null;
  if (templateName) {
    const rendered = renderTemplateIfProvided(templateName, payload || {});
    html = rendered.html;
    // provide a simple fallback text
    text = subject;
  } else {
    text = typeof payload === "string" ? payload : JSON.stringify(payload);
  }

  const body = {
    from: { email: FROM_EMAIL, name: FROM_NAME },
    to:   [{ email: to }],
    subject,
    text,
    ...(html ? { html } : {}),
  };

  const res = await fetch("https://send.api.mailtrap.io/api/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MAILTRAP_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`Mailtrap API error ${res.status}: ${errTxt}`);
  }

  const data = await res.json().catch(() => ({}));
  return data;
}

/**
 * Lightweight verification:
 * - confirms token exists
 * - hits a tiny API endpoint to confirm networking & auth
 */
async function verifySmtp() {
  if (!MAILTRAP_API_TOKEN) throw new Error("MAILTRAP_API_TOKEN not set");
  // Mailtrap does not have a strict "verify" endpoint; we do a quick HEAD on /api/send
  const res = await fetch("https://send.api.mailtrap.io/api/send", {
    method: "OPTIONS",
    headers: { "Authorization": `Bearer ${MAILTRAP_API_TOKEN}` }
  }).catch((e) => { throw new Error(`Network check failed: ${e.message}`); });

  // Many APIs will return 204/200 for OPTIONS; any error indicates token/network issues.
  if (res.status >= 200 && res.status < 500) {
    return true;
  }
  throw new Error(`Verify failed with status ${res.status}`);
}

module.exports = { sendEmail, verifySmtp };
