// utils/mailer_https.js
const fs = require("fs/promises");
const path = require("path");
const Handlebars = require("handlebars");

// Mailtrap HTTP API
const MAILTRAP_API_BASE = process.env.MAILTRAP_API_BASE || "https://send.api.mailtrap.io";
const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN;
const MAIL_SENDER_EMAIL = process.env.MAIL_SENDER_EMAIL || "no-reply@example.com";
const MAIL_SENDER_NAME  = process.env.MAIL_SENDER_NAME  || "Saka360";

if (!MAILTRAP_API_TOKEN) {
  console.warn("[mailer_https] MAILTRAP_API_TOKEN is missing — sending will fail until set.");
}

/**
 * Render a handlebars template from disk.
 * @param {string} absPath Absolute path to .hbs
 * @param {object} data Template data
 * @returns {Promise<string>} HTML
 */
async function renderTemplate(absPath, data) {
  try {
    const src = await fs.readFile(absPath, "utf8");
    const tpl = Handlebars.compile(src);
    return tpl(data || {});
  } catch (e) {
    // Surface a clear error for missing/invalid templates
    throw new Error(`Template render failed for ${absPath}: ${e.message}`);
  }
}

/**
 * Send an email via Mailtrap HTTP API
 * @param {object} param0
 * @param {string} param0.to
 * @param {string} param0.subject
 * @param {string} [param0.html]
 * @param {string} [param0.text]
 */
async function sendMailHttp({ to, subject, html, text }) {
  if (!MAILTRAP_API_TOKEN) {
    throw new Error("MAILTRAP_API_TOKEN not configured");
  }
  if (!to) throw new Error("Missing 'to'");
  if (!subject) throw new Error("Missing 'subject'");

  // Ensure text is string
  const textString = typeof text === "string" ? text : (text ? String(text) : "");

  const payload = {
    from: {
      email: MAIL_SENDER_EMAIL,
      name: MAIL_SENDER_NAME
    },
    to: [{ email: to }],
    subject,
    text: textString || undefined,
    html: html || undefined,
    category: "transactional"
  };

  const res = await fetch(`${MAILTRAP_API_BASE}/api/send`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${MAILTRAP_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

  if (!res.ok) {
    throw new Error(`Mailtrap API failed ${res.status}: ${body}`);
  }
  // Mailtrap returns { success:true, message_ids:[...] } or similar
  return {
    messageId: parsed?.message_ids?.[0] || parsed?.message_id || "dev-preview"
  };
}

module.exports = { sendMailHttp, renderTemplate };
