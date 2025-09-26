const nodemailer = require("nodemailer");
const hbs = require("handlebars");
const fs = require("fs");
const path = require("path");

// Email transport (your SMTP)
const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Function to send email with template
async function sendEmail(to, subject, templateName, variables) {
  const templatePath = path.join(__dirname, "../templates", `${templateName}.hbs`);
  const source = fs.readFileSync(templatePath, "utf8");
  const compiled = hbs.compile(source);
  const html = compiled(variables);

  await transporter.sendMail({
    from: `"Saka360" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html
  });
}

module.exports = { sendEmail };
