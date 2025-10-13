// utils/mailer.js
const nodemailer = require("nodemailer");

function buildTransporter({ host, port, secure, user, pass }) {
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure: secure === true || String(secure).toLowerCase() === "true", // true for 465
    auth: { user, pass },
    // helpful timeouts & logs
    connectionTimeout: 15000, // 15s
    greetingTimeout: 10000,
    socketTimeout: 20000,
    logger: true,
    debug: true,
  });
}

async function trySend({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || `Saka360 <${process.env.SMTP_USER}>`;

  // First attempt: .env settings (probably 465/SSL)
  const t1 = buildTransporter({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 465,
    secure: process.env.SMTP_SECURE ?? true,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  });

  try {
    return await t1.sendMail({ from, to, subject, text, html: html || text });
  } catch (e1) {
    console.error("❌ SMTP attempt #1 failed:", e1 && e1.message);

    // Fallback attempt: 587 STARTTLS (common when 465 blocked)
    const t2 = buildTransporter({
      host: process.env.SMTP_HOST,
      port: 587,
      secure: false, // STARTTLS
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    });

    try {
      return await t2.sendMail({ from, to, subject, text, html: html || text });
    } catch (e2) {
      console.error("❌ SMTP attempt #2 failed:", e2 && e2.message);
      throw e2; // bubble up final error
    }
  }
}

async function sendEmail(to, subject, templateNameOrNull, valuesOrText) {
  // For now we’re sending plain text only in the test route
  const text = typeof valuesOrText === "string" ? valuesOrText : "";
  return trySend({ to, subject, text });
}

async function verifySmtp() {
  const t = buildTransporter({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 465,
    secure: process.env.SMTP_SECURE ?? true,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  });

  try {
    await t.verify();
    return true;
  } catch (e1) {
    console.error("❌ verify() on primary failed:", e1 && e1.message);
    // Retry on 587 STARTTLS
    const t2 = buildTransporter({
      host: process.env.SMTP_HOST,
      port: 587,
      secure: false,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    });
    await t2.verify(); // will throw if also fails
    return true;
  }
}

module.exports = { sendEmail, verifySmtp };
