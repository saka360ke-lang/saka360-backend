// utils/mailer.js
//
// Pure HTTP Mailtrap (Send API) mailer (no SMTP).
// Fixes: Mailtrap requires `from` to be an object, not a string.
//
// Required ENV (Render → Environment):
//   MAILTRAP_API_TOKEN=   (Mailtrap Email Sending → API → Tokens)
//   SMTP_FROM= Saka360 <no-reply@saka360.com>   (your verified sender in Mailtrap)
//
// Optional:
//   MAILTRAP_API_BASE=https://send.api.mailtrap.io

const MAILTRAP_API_BASE = (process.env.MAILTRAP_API_BASE || "https://send.api.mailtrap.io").replace(/\/$/, "");
const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN || "";
const FROM_RAW = process.env.SMTP_FROM || "Saka360 <no-reply@saka360.com>";

// Parse "Name <email@domain>" or "email@domain" into { email, name? }
function parseAddress(input) {
  if (!input) return null;
  if (typeof input === "object" && input.email) {
    // already an object {email,name?}
    return { email: String(input.email), ...(input.name ? { name: String(input.name) } : {}) };
  }
  const s = String(input).trim();
  const m = s.match(/^(.+?)\s*<([^>]+)>$/); // Name <email>
  if (m) {
    const name = m[1].trim();
    const email = m[2].trim();
    return { email, ...(name ? { name } : {}) };
  }
  // just an email
  return { email: s };
}

// Normalize recipients: string | object | array -> [{email,name?}, ...]
function normalizeRecipients(to) {
  if (!to) throw new Error("Missing 'to'");
  if (Array.isArray(to)) return to.map(parseAddress).filter(Boolean);
  return [parseAddress(to)];
}

function assertConfigured() {
  if (!MAILTRAP_API_TOKEN) {
    throw new Error("MAILTRAP_API_TOKEN missing (Mailtrap Email Sending → API → Tokens).");
  }
  const fromObj = parseAddress(FROM_RAW);
  if (!fromObj?.email) {
    throw new Error("SMTP_FROM invalid. Use format like: Saka360 <no-reply@saka360.com>");
  }
}

async function verifySmtp() {
  try {
    assertConfigured();
    // No ping endpoint; if token + from parse OK, consider verified.
    return true;
  } catch (e) {
    console.error("[mailer] verify failed:", e.message);
    return false;
  }
}

/**
 * sendEmail(to, subject, html, text?)
 * - `to`: string | {email,name?} | Array of those
 * - `subject`: string
 * - `html`: string
 * - `text`: string (optional)
 */
async function sendEmail(to, subject, html, text) {
  assertConfigured();

  const from = parseAddress(FROM_RAW);
  const toList = normalizeRecipients(to);

  const url = `${MAILTRAP_API_BASE}/api/send`;
  const payload = {
    from,                 // { email, name? }
    to: toList,           // [ { email, name? }, ... ]
    subject,
    html,
    ...(text ? { text } : {}),
    category: "saka360",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Token": MAILTRAP_API_TOKEN,   // IMPORTANT header name
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  // Parse body for better error messages
  let bodyText = "";
  try { bodyText = await res.text(); } catch {}

  if (!res.ok) {
    throw new Error(`Mailtrap API failed ${res.status}: ${bodyText || "<no body>"}`);
  }

  // Optionally parse JSON if you want the id:
  try {
    const json = bodyText ? JSON.parse(bodyText) : {};
    return { messageId: json?.message_ids?.[0] || "api-mailtrap" };
  } catch {
    return { messageId: "api-mailtrap" };
  }
}

module.exports = { verifySmtp, sendEmail };
