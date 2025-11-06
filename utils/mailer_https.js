// utils/mailer_https.js
const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

const API_BASE = process.env.MAILTRAP_API_BASE || "https://send.api.mailtrap.io";
const API_TOKEN = process.env.MAILTRAP_API_TOKEN;
const SENDER_EMAIL = process.env.MAIL_SENDER_EMAIL || "no-reply@example.com";
const SENDER_NAME  = process.env.MAIL_SENDER_NAME  || "Saka360";
const TEMPLATE_DIR = process.env.TEMPLATE_DIR || "templates";

/** Load and compile a handlebars template from /templates/emails/<name>.hbs */
function renderTemplate(name, vars = {}) {
  const file = path.join(process.cwd(), TEMPLATE_DIR, "emails", `${name}.hbs`);
  if (!fs.existsSync(file)) {
    throw new Error(`Template not found: ${file}`);
  }
  const src = fs.readFileSync(file, "utf8");
  const tpl = Handlebars.compile(src, { noEscape: true });
  return tpl(vars || {});
}

/** Very simple HTML -> text fallback */
function htmlToText(html = "") {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Send email via Mailtrap HTTP API with HTML (rendered from handlebars).
 * @param {Object} opts
 *  - to: string | {email,name}
 *  - subject: string
 *  - template: string (file name without .hbs in templates/emails/)
 *  - variables: object (template variables)
 *  - cc/bcc: optional arrays
 */
async function sendMailHttp({ to, subject, template, variables = {}, cc = [], bcc = [] }) {
  if (!API_TOKEN) throw new Error("MAILTRAP_API_TOKEN missing");
  if (!template) throw new Error("template is required");

  const html = renderTemplate(template, variables);
  const text = htmlToText(html);

  const toArr = Array.isArray(to)
    ? to.map(t => (typeof t === "string" ? { email: t } : t))
    : [typeof to === "string" ? { email: to } : to];

  const body = {
    from: { email: SENDER_EMAIL, name: SENDER_NAME },
    to: toArr,
    subject,
    html,
    text,               // Mailtrap expects string, not object
  };

  if (cc?.length) body.cc = cc.map(x => (typeof x === "string" ? { email: x } : x));
  if (bcc?.length) body.bcc = bcc.map(x => (typeof x === "string" ? { email: x } : x));

  const res = await fetch(`${API_BASE}/api/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || data?.success === false) {
    throw new Error(`Mailtrap API failed ${res.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

module.exports = { sendMailHttp };
