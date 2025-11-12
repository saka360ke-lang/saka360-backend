// routes/whatsapp.js
const express = require("express");
const router = express.Router();

function getPool(req) {
  const pool = req.app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");
  return pool;
}

// Minimal auth: treat from number as the user’s email/identity if you have a mapping.
// For now, we assume you’ve stored whatsapp in users table (phone->user).
async function findUserByWhatsApp(pool, waFrom) {
  // waFrom like: "whatsapp:+2547XXXX..."
  const phone = (waFrom || "").replace(/^whatsapp:/, "");
  const q = await pool.query(`SELECT id, email, name FROM users WHERE phone = $1 OR whatsapp = $1 LIMIT 1`, [phone]);
  return q.rows[0] || null;
}

// create a short init helper reusing payments.start code downstream
async function startCheckout(pool, userId, planInput, baseUrl) {
  const sql = `
    SELECT code, name, price_amount, price_cents,
           COALESCE(currency, price_currency, 'KES') AS currency,
           is_active
    FROM subscription_plans
    WHERE UPPER(code)=UPPER($1)
       OR REGEXP_REPLACE(UPPER(name),'[^A-Z0-9]','','g')
          = REGEXP_REPLACE(UPPER($1),'[^A-Z0-9]','','g')
    LIMIT 1
  `;
  const plan = (await pool.query(sql, [planInput])).rows[0];
  if (!plan || !plan.is_active) return { error: "Unknown or inactive plan" };

  // Build a fake “start” payload to your own /api/payments/start so we reuse all logic
  const resp = await fetch(`${baseUrl}/api/payments/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer WHATSAPP-SERVICE-JWT` }, // If you have a service token
    body: JSON.stringify({ plan_code: plan.code || planInput })
  }).catch(() => null);

  if (!resp || !resp.ok) return { error: "Failed to initialize checkout" };
  const data = await resp.json();
  if (!data?.ok) return { error: data?.error || "Failed to initialize checkout" };
  return { url: data.authorization_url, name: plan.name };
}

// Twilio webhook (form-encoded)
module.exports = (app) => {
  const pool = app.get("pool");
  router.post("/webhooks/whatsapp", express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const from = req.body.From; // "whatsapp:+2547..."
      const body = (req.body.Body || "").trim();
      const user = await findUserByWhatsApp(pool, from);

      const lower = body.toLowerCase();

      // Help
      if (!user || lower === "help") {
        const msg =
`Saka360 WhatsApp Help:
• my vehicles
• service 10,000 for <plate|make|model>
• set reminders email on|off whatsapp on|off days <N>
• upload: send a photo/PDF (caption a plate helps)
• upgrade <free|basic|premium|fleet pro>
• billing (see plan & usage)
• cancel plan (soft cancel)
`;
        return res.type("text/plain").send(msg);
      }

      // billing
      if (lower === "billing") {
        const bs = await (await fetch(`${process.env.APP_BASE_URL}/api/payments/status`, {
          headers: { "Authorization": `Bearer WHATSAPP-SERVICE-JWT` }
        })).json().catch(() => null);

        if (!bs || bs.error) return res.type("text/plain").send("Couldn’t load billing right now. Try later.");
        const { plan, usage } = bs;
        const reply = `Your plan: ${plan.code}
Vehicles: ${usage.vehicles}/${plan.maxVehicles}
Docs enabled: ${plan.docsEnabled ? "Yes" : "No"}
WhatsApp reminders: ${plan.whatsappReminders ? "Yes" : "No"}
Type: upgrade basic | premium | fleet pro`;
        return res.type("text/plain").send(reply);
      }

      // upgrade <plan>
      if (lower.startsWith("upgrade ")) {
        const which = lower.replace(/^upgrade\s+/i, "").trim();
        const resp = await startCheckout(pool, user.id, which, process.env.APP_BASE_URL);
        if (resp.error) return res.type("text/plain").send(resp.error);
        return res.type("text/plain").send(`Upgrade to ${resp.name}\nPay here:\n${resp.url}`);
      }

      // cancel plan
      if (lower === "cancel plan") {
        await pool.query(
          `UPDATE user_subscriptions SET status='canceled', renewed_at = NOW()
           WHERE user_id=$1 AND status='active'`,
          [user.id]
        );
        return res.type("text/plain").send("Your plan has been marked as canceled. You’ll stay active until the end of your cycle.");
      }

      // fallback
      return res.type("text/plain").send(`I didn’t catch that. Type "help" to see commands.`);
    } catch (e) {
      console.error("whatsapp webhook error:", e);
      return res.type("text/plain").send("Sorry, something went wrong.");
    }
  });

  app.use("/api", router);
};
