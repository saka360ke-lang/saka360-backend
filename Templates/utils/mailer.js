const nodemailer = require("nodemailer");
const handlebars = require("handlebars");
const fs = require("fs-extra");
const path = require("path");

// Setup the email transporter (connection to your email account)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com", // Or smtp.hostinger.com if you're using Hostinger
  port: process.env.SMTP_PORT || 587,              // Usually 587 for TLS, 465 for SSL
  secure: false, // true if port = 465
  auth: {
    user: process.env.SMTP_USER, // Your email address (set in .env file)
    pass: process.env.SMTP_PASS  // Your email password (set in .env file)
  }
});

// Load and compile a Handlebars template
async function compileTemplate(templateName, data) {
  const filePath = path.join(__dirname, "..", "templates", `${templateName}.hbs`);
  const source = await fs.readFile(filePath, "utf-8");
  const template = handlebars.compile(source);
  return template(data); // Insert variables into the template
}

// Send an email with a specific template
async function sendEmail(to, subject, templateName, data, attachments = []) {
  const html = await compileTemplate(templateName, data);

  const mailOptions = {
    from: '"Saka360" <no-reply@saka360.com>',
    to,
    subject,
    html,
    attachments
  };

  const info = await transporter.sendMail(mailOptions);
  console.log("📧 Email sent:", info.messageId);
}

module.exports = { sendEmail };
