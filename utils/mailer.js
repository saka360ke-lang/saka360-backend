const nodemailer = require("nodemailer");
const hbs = require("handlebars");
const fs = require("fs");
const path = require("path");

// 1) Transport using env vars from Render
const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465,
  secure: true, // SSL
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// 2) Verify helper (useful for quick diagnostics)
async function verifySmtp() {
  return transporter.verify();
}

// 3) Load and compile a .hbs template by name
function renderTemplate(templateName, variables = {}) {
  const templatePath = path.join(__dirname, "../templates", `${templateName}.hbs`);
  const source = fs.readFileSync(templatePath, "utf8");
  const compiled = hbs.compile(source);
  return compiled(variables);
}

/**
 * sendEmail
 * - If templateName is provided, renders templates/<templateName>.hbs with variables
 * - If no templateName, sends a simple text-only email
 */
async function sendEmail(to, subject, templateName = null, variablesOrText = {}) {
  let html = null;
  let text = null;

  if (templateName) {
    html = renderTemplate(templateName, variablesOrText || {});
  } else {
    // plain text mode
    text = typeof variablesOrText === "string" ? variablesOrText : "Hello from Saka360!";
  }

  const info = await transporter.sendMail({
    from: `"Saka360" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text: text || undefined,
    html: html || undefined
  });

  return info;
}

module.exports = { sendEmail, verifySmtp };
