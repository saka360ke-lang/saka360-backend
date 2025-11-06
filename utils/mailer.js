// utils/mailer.js
//
// Pure HTTP Mailtrap (Send API) mailer.
// No SMTP. No nodemailer. Works on Render without special ports.
//
// ENV required:
//   MAILTRAP_API_TOKEN=  (from Mailtrap Email Sending -> API -> Tokens)
//   SMTP_FROM= Saka360 <no-reply@saka360.com>   (display name + email you verified in Mailtrap)
// Optional:
//   MAILTRAP_API_BASE=https://send.api.mailtrap.io   (default already set)

const MAILTRAP_API_BASE = (process.env.MAILTRAP_API_BASE || "https://send.api.mailtrap.io").replace(/\/$/, "");
const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN || "";
const FROM = process.env.SMTP_FROM || "Saka360 <no-reply@saka360.com>";

function assertConfigured() {
  if (!MAILTRAP_API_TOKEN) {
    throw new Error("MAILTRAP_API_TOKEN missing (Mailtrap Email Sending → API → Tokens).");
  }
  if (!FROM) {
    throw new Error("SMTP_FROM missing (e.g., 'Saka360 <no-reply@saka360.com>').");
  }
}

/**
 * verifySmtp() kept for compatibility with existing routes.
 * In HTTP mode we just check config is present and do a lightweight call.
 */
async function verifySmtp() {
  try {
    assertConfigured();
    // Do a tiny no-op: Mailtrap doesn't provide a ping endpoint for Send API,
    // so we just return true if token is present.
    return true;
  } catch (e) {
    console.error("[mailer] verify failed:", e.message);
    return false;
  }
}

/**
 * sendEmail(to, subject, html, text?)
 * Uses Mailtrap Send API (HTTP)
 */
async function sendEmail(to, subject, html, text) {
  assertConfigured();

  const url = `${MAILTRAP_API_BASE}/api/send`;
  const payload = {
    from: FROM,
    to: [{ email: to }],
    subject,
    html,
    ...(text ? { text } : {}),
    category: "saka360",
  };

  // Node 18+/20+ has global fetch; no dependency required.
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Token": MAILTRAP_API_TOKEN,   // <— important header name
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Mailtrap API failed ${res.status}: ${body}`);
  }

  // Mailtrap returns JSON; but we don’t need the full payload for now.
  return { messageId: "api-mailtrap" };
}

module.exports = { verifySmtp, sendEmail };
