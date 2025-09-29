// utils/mailer.js
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const handlebars = require("handlebars");

// =======================
// 1. Setup transporter
// =======================
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.hostinger.com",
  port: process.env.SMTP_PORT || 465,
  secure: true, // SSL
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// =======================
// 2. Verify SMTP connection
// =======================
async function verifySmtp() {
  try {
    await transporter.verify();
    console.log("✅ SMTP connection is ready");
    return true;
  } catch (err) {
    console.error("❌ SMTP verify failed:", err);
    throw err;
  }
}

// =======================
// 3. Load and compile template
// =======================
function loadTemplate(templateName, variables) {
  const templatePath = path.join(__dirname, "..", "templates", `${templateName}.hbs`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template file not found: ${templatePath}`);
  }

  const source = fs.readFileSync(templatePath, "utf8");
  const compiled = handlebars.compile(source);
  return compiled(variables);
}

// =======================
// 4. Send Email
// =======================
// Usage examples:
// - With template: sendEmail("user@mail.com", "Verify Account", "verification", { verification_link: "..." })
// - Plain text: sendEmail("user@mail.com", "Hello", null, "Just testing")
async function sendEmail(to, subject, templateName = null, variablesOrText = {}) {
  try {
    let htmlBody, textBody;

    if (templateName) {
      // Render from template
      htmlBody = loadTemplate(templateName, variablesOrText);
      textBody = subject; // fallback plain text
    } else {
      // Use plain text body directly
      textBody = typeof variablesOrText === "string" ? variablesOrText : "";
      htmlBody = `<p>${textBody}</p>`;
    }

    const info = await transporter.sendMail({
      from: `"Saka360" <${process.env.SMTP_USER}>`,
      to,
      subject,
      text: textBody,
      html: htmlBody,
    });

    console.log("📧 Email sent:", info.messageId);
    return info;
  } catch (err) {
    console.error("❌ Email error:", err);
    throw err;
  }
}

module.exports = {
  sendEmail,
  verifySmtp,
};
