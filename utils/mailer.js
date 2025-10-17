// utils/mailer.js
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const handlebars = require("handlebars");
const { sendEmailHTTP } = require("./mailer_http");

// ------- ENV (SMTP) -------
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true"; // true for 465
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || "no-reply@saka360.com";
const FROM_NAME = process.env.FROM_NAME || "Saka360";

// Small helper for logging
function log(...args) {
  // keep logs lightweight in prod
  console.log("[mailer]", ...args);
}

// Build (or reuse) an SMTP transport
function buildTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    log("SMTP not configured – missing host/user/pass");
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 10000,    // 10s
    greetingTimeout: 10000,      // 10s
    socketTimeout: 20000         // 20s
  });
}

const smtpTransport = buildTransport();

// Compile a handlebars template from /templates
function compileTemplate(templateName, data) {
  const file = path.join(__dirname, "..", "templates", `${templateName}.hbs`);
  if (!fs.existsSync(file)) {
    throw new Error(`Template file not found: ${file}. Ensure correct name/casing.`);
  }
  const source = fs.readFileSync(file, "utf8");
  const tpl = handlebars.compile(source);
  return tpl(data || {});
}

// ----- Public: verify SMTP connectivity -----
async function verifySmtp() {
  if (!smtpTransport) throw new Error("SMTP not configured");
  return smtpTransport.verify(); // throws on error
}

// ----- Internal: send via SMTP only -----
async function sendEmailSMTP(to, subject, templateName, dataOrPlainText) {
  if (!smtpTransport) throw new Error("SMTP not configured");

  let html = null;
  let text = null;

  if (templateName) {
    html = compileTemplate(templateName, dataOrPlainText || {});
  } else {
    // Plain-text mode
    text = String(dataOrPlainText || "");
  }

  const info = await smtpTransport.sendMail({
    from: { name: FROM_NAME, address: FROM_EMAIL },
    to,
    subject,
    ...(html ? { html } : { text })
  });

  return { method: "smtp", messageId: info.messageId };
}

// ----- Public: SMART sender (SMTP first → HTTP fallback) -----
async function sendEmail(to, subject, templateName, dataOrPlainText) {
  // 1) Try SMTP if configured
  if (smtpTransport) {
    try {
      const result = await sendEmailSMTP(to, subject, templateName, dataOrPlainText);
      log("SMTP send OK:", result.messageId);
      return result;
    } catch (err) {
      // Only fall back on connectivity / transient errors
      const msg = (err && err.message || "").toLowerCase();
      const code = err && err.code;
      const transient =
        code === "ETIMEDOUT" ||
        code === "ECONNECTION" ||
        code === "EAUTH" ||
        msg.includes("timeout") ||
        msg.includes("unable to verify") ||
        msg.includes("connection") ||
        msg.includes("greeting");

      log("SMTP send failed:", code || "", msg);
      if (!transient) {
        // template missing or logic error? rethrow (don’t hide real bugs)
        throw err;
      }
      // else continue to HTTP
    }
  }

  // 2) Fallback to Mailtrap HTTP API
  if (!templateName) {
    // HTTP API requires HTML; if caller passed plain text, wrap it
    dataOrPlainText = { body_text: String(dataOrPlainText || "") };
    templateName = "__plain_fallback";
  }

  // Provide a tiny plain template if caller used plain text
  if (templateName === "__plain_fallback") {
    const html = `<pre style="font-family:Arial, sans-serif; white-space:pre-wrap; line-height:1.5">${dataOrPlainText.body_text}</pre>`;
    // Send directly with HTTP without reading file
    const axios = require("axios");
    const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN;
    const SENDER_EMAIL = process.env.MAILTRAP_SENDER_EMAIL || FROM_EMAIL;
    const SENDER_NAME = process.env.MAILTRAP_SENDER_NAME || FROM_NAME;
    if (!MAILTRAP_API_TOKEN) throw new Error("MAILTRAP_API_TOKEN not set for HTTP fallback");

    const resp = await axios.post("https://send.api.mailtrap.io/api/send", {
      from: { email: SENDER_EMAIL, name: SENDER_NAME },
      to: [{ email: to }],
      subject,
      html
    }, {
      headers: { "Content-Type": "application/json", "Api-Token": MAILTRAP_API_TOKEN },
      timeout: 20000
    });

    log("HTTP fallback sent (plain).");
    return { method: "http", id: resp.data?.message_ids?.[0] || null };
  }

  // Normal template path through HTTP sender
  const httpRes = await sendEmailHTTP(to, subject, templateName, dataOrPlainText);
  log("HTTP fallback sent:", httpRes.id);
  return { method: "http", id: httpRes.id };
}

module.exports = { sendEmail, verifySmtp };
