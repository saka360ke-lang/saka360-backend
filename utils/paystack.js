// utils/paystack.js
const crypto = require("crypto");

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = process.env.PAYSTACK_BASE || "https://api.paystack.co";

// Node 20+ has global fetch
async function psFetch(path, opts = {}) {
  const url = `${PAYSTACK_BASE}${path}`;
  const headers = new Headers(opts.headers || {});
  headers.set("Authorization", `Bearer ${PAYSTACK_SECRET_KEY}`);
  headers.set("Content-Type", "application/json");
  const res = await fetch(url, { ...opts, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.status === false) {
    const msg = json?.message || res.statusText || "Paystack API error";
    throw new Error(`Paystack API failed: ${msg}`);
  }
  return json;
}

// Initialize a transaction (card or mobile money / M-Pesa)
async function initializeTransaction({ email, amount_minor, currency = "KES", metadata = {}, channels = undefined, callback_url = undefined }) {
  const body = {
    email,
    amount: amount_minor, // minor units
    currency,
    metadata,
  };
  if (Array.isArray(channels) && channels.length) body.channels = channels;
  if (callback_url) body.callback_url = callback_url;

  const json = await psFetch("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify(body),
  });
  // json.data.authorization_url, json.data.reference
  return json.data;
}

// Verify webhook signature (SHA512 of raw body with secret)
function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !PAYSTACK_SECRET_KEY) return false;
  const hmac = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY);
  const digest = hmac.update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(digest));
}

module.exports = {
  initializeTransaction,
  verifySignature,
};
