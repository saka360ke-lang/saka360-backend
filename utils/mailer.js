const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const handlebars = require("handlebars");

// Optional debug switch: set SMTP_DEBUG=true in .env to see verbose logs
const SMTP_DEBUG = String(process.env.SMTP_DEBUG || "").toLowerCase() === "true";

// --- Transport (works with Mailtrap, Hostinger, etc.) ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,              // e.g. live.smtp.mailtrap.io or smtp.hostinger.com
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true", // true = 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  pool: true, // reuse connection
  maxConnections: 3,
  maxMessages: 50,
  logger: SMTP_DEBUG,
  debug: SMTP_DEBUG
});

async function verifySmtp() {
  return transporter.verify();
}

// Cache compiled templates in memory
const templateCache = new Map();

function loadTemplate(templateName) {
  const safeName = String(templateName).trim();

  // path: /templates/<templateName>.hbs (lowercase filenames!)
  const filePath = path.join(process.cwd(), "templates", `${safeName}.hbs`);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Template file not found: ${filePath}. ` +
      `Ensure the file exists and matches the name/casing (e.g. 'verification.hbs').`
    );
  }

  const fileContent = fs.readFileSync(filePath, "utf8");
  return handlebars.compile(fileContent);
}

/**
 * sendEmail
 *  - If templateName is provided -> render HTML from /templates/<templateName>.hbs
 *  - If no templateName -> send plain text (bodyPlain required)
 *
 * @param {string} to
 * @param {string} subject
 * @param {string|null} templateName  e.g. "verification" (without .hbs)
 * @param {object|string} dataOrPlain If templateName given: variables object; else: plain string body
 */
async function sendEmail(to, subject, templateName = null, dataOrPlain = null) {
  let html = null;
  let text = null;

  if (templateName) {
    // Use Handlebars template
    const cacheKey = templateName.toLowerCase();
    let compiled = templateCache.get(cacheKey);
    if (!compiled) {
      compiled = loadTemplate(templateName);
      templateCache.set(cacheKey, compiled);
    }
    const data = dataOrPlain || {}; // variables for HBS
    html = compiled({
      // sensible defaults every template can use
      app_name: "Saka360",
      support_email: "support@saka360.com",
      year: new Date().getFullYear(),
      ...data
    });
  } else {
    // Plain text
    if (!dataOrPlain || typeof dataOrPlain !== "string") {
      throw new Error("Plain text email requires a string body when templateName is null");
    }
    text = dataOrPlain;
  }

  const mailOptions = {
    from: process.env.MAIL_FROM || "Saka360 <no-reply@saka360.com>",
    to,
    subject,
    // If html exists use it, otherwise text
    ...(html ? { html } : { text })
  };

  if (SMTP_DEBUG) {
    console.log("📧 sendEmail() →", { to, subject, templateName, usedHtml: !!html });
  }

  const info = await transporter.sendMail(mailOptions);
  if (SMTP_DEBUG) console.log("✅ Email sent:", info.messageId);
  return info;
}

module.exports = { transporter, sendEmail, verifySmtp };
