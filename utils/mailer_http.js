// utils/mailer_http.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const handlebars = require("handlebars");

// Env variables from Render dashboard
const MAILTRAP_API_TOKEN = process.env.MAILTRAP_API_TOKEN;
const SENDER_EMAIL = process.env.MAILTRAP_SENDER_EMAIL || "no-reply@saka360.com";
const SENDER_NAME = process.env.MAILTRAP_SENDER_NAME || "Saka360";

/**
 * Compile the given template (.hbs) from /templates
 */
function compileTemplate(templateName, data) {
  const filePath = path.join(__dirname, "..", "templates", `${templateName}.hbs`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Template not found: ${filePath}`);
  }

  const source = fs.readFileSync(filePath, "utf8");
  const template = handlebars.compile(source);
  return template(data || {});
}

/**
 * Send email via Mailtrap Email Sending API (HTTPS)
 * Docs: https://api.mailtrap.io/
 */
async function sendEmailHTTP(to, subject, templateName, data) {
  if (!MAILTRAP_API_TOKEN) throw new Error("Missing MAILTRAP_API_TOKEN env");

  const html = compileTemplate(templateName, data);
  const payload = {
    from: { email: SENDER_EMAIL, name: SENDER_NAME },
    to: [{ email: to }],
    subject,
    html,
  };

  const resp = await axios.post("https://send.api.mailtrap.io/api/send", payload, {
    headers: {
      "Content-Type": "application/json",
      "Api-Token": MAILTRAP_API_TOKEN,
    },
    timeout: 20000,
  });

  return { status: resp.status, id: resp.data?.message_ids?.[0] || null };
}

module.exports = { sendEmailHTTP };
