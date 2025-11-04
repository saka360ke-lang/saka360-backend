// utils/mailer.js
const nodemailer = require("nodemailer");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

/**
 * Two modes:
 *  A) HTTP (Mailtrap Send API) when MAILTRAP_API_TOKEN is set
 *  B) SMTP (Nodemailer) when SMTP_HOST/PORT/USER/PASS are set
 *
 * verifySmtp() will resolve true in HTTP mode (no-op), so your existing
 * /api/email-verify route continues to “pass” when using HTTP.
 */

const FROM = process.env.SMTP_FROM || "Saka360 <no-reply@saka360.com>";

// ----------------------------
// Mode A: HTTP (Mailtrap Send)
// ----------------------------
const MAILTRAP_API_BASE = process.env.MAILTRAP_API_BASE || "https://send.api.mailtrap.io";
const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN || "";

// ----------------------------
// Mode B: SMTP (Nodemailer)
// ----------------------------
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

function usingHttpApi() {
  return !!MAILTRAP_API_TOKEN;
}

let smtpTransport = null;
function getSmtpTransport() {
  if (!smtpTransport) {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
      throw new Error("SMTP not configured – missing SMTP_HOST/SMTP_USER/SMTP_PASS");
    }
    smtpTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 587 usually STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return smtpTransport;
}

async function verifySmtp() {
  if (usingHttpApi()) {
    // HTTP mode doesn't need SMTP verification
    return true;
  }
  try {
    const t = getSmtpTransport();
    await t.verify();
    return true;
  } catch (e) {
    console.error("[mailer] SMTP verify failed:", e.message);
    return false;
  }
}

/**
 * sendEmail(to, subject, html, text?)
 * - In HTTP mode, calls Mailtrap Send API
 * - In SMTP mode, uses Nodemailer
 */
async function sendEmail(to, subject, html, text) {
  if (usingHttpApi()) {
    // HTTP API mode
    const url = `${MAILTRAP_API_BASE.replace(/\/$/, "")}/api/send`;
    const payload = {
      from: FROM,
      to: [{ email: to }],
      subject,
      html,
      ...(text ? { text } : {}),
      category: "saka360",
    };
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Api-Token": MAILTRAP_API_TOKEN, // Mailtrap expects Api-Token header
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Mailtrap API failed ${res.status}: ${body}`);
    }
    return { messageId: "api-mailtrap" };
  }

  // SMTP mode
  const t = getSmtpTransport();
  const info = await t.sendMail({
    from: FROM,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
  });
  return { messageId: info.messageId || "smtp-mailtrap" };
}

module.exports = { verifySmtp, sendEmail };
