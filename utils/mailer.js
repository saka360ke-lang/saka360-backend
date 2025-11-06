// utils/mailer.js
//
// Mailtrap Send API (HTTP) mailer.
// Ensures `from` is an object and `text` is a string.
//
// Required ENV:
//   MAILTRAP_API_TOKEN = <Mailtrap Email Sending API token>
//   SMTP_FROM          = "Saka360 <no-reply@saka360.com>" (a verified sender in Mailtrap)
// Optional:
//   MAILTRAP_API_BASE  = https://send.api.mailtrap.io

const MAILTRAP_API_BASE = (process.env.MAILTRAP_API_BASE || "https://send.api.mailtrap.io").replace(/\/$/, "");
const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN || "";
const FROM_RAW = process.env.SMTP_FROM || "Saka360 <no-reply@saka360.com>";

function parseAddress(input) {
  if (!input) return null;
  if (typeof input === "object" && input.email) {
    return { email: String(input.email), ...(input.name ? { name: String(input.name) } : {}) };
  }
  const s = String(input).trim();
  const m = s.match(/^(.+?)\s*<([^>]+)>$/);
  if (m) {
    const name = m[1].trim();
    const email = m[2].trim();
    return { email, ...(name ? { name } : {}) };
  }
  return { email: s };
}
function normalizeRecipients(to) {
  if (!to) throw new Error("Missing 'to'");
  if (Array.isArray(to)) return to.map(parseAddress).filter(Boolean);
  return [parseAddress(to)];
}
function assertConfigured() {
  if (!MAILTRAP_API_TOKEN) throw new Error("MAILTRAP_API_TOKEN missing.");
  const fromObj = parseAddress(FROM_RAW);
  if (!fromObj?.email) throw new Error("SMTP_FROM invalid. Use: Name <email@domain>");
}
function htmlToText(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
}

async function verifySmtp() {
  try { assertConfigured(); return true; } catch { return false; }
}

/**
 * sendEmail(to, subject, html, text?)
 * `text` will be coerced to a string or auto-generated from html.
 */
async function sendEmail(to, subject, html, text) {
  assertConfigured();

  const from = parseAddress(FROM_RAW);
  const toList = normalizeRecipients(to);

  // Coerce/auto-generate text
  let textOut = undefined;
  if (typeof text === "string") {
    textOut = text;
  } else if (text != null) {
    textOut = String(text);
  } else if (html) {
    textOut = htmlToText(html);
  }

  const payload = {
    from,                 // { email, name? }
    to: toList,           // [ { email, name? }, ... ]
    subject: String(subject || ""),
    html: String(html || ""),
    ...(textOut ? { text: textOut } : {}),     // only include if string present
    category: "saka360",
  };

  const res = await fetch(`${MAILTRAP_API_BASE}/api/send`, {
    method: "POST",
    headers: {
      "Api-Token": MAILTRAP_API_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Mailtrap API failed ${res.status}: ${bodyText || "<no body>"}`);

  try {
    const json = bodyText ? JSON.parse(bodyText) : {};
    return { messageId: json?.message_ids?.[0] || "api-mailtrap" };
  } catch {
    return { messageId: "api-mailtrap" };
  }
}

module.exports = { verifySmtp, sendEmail };
