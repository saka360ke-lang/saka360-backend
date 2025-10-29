// routes/chat.js
const express = require("express");
const router = express.Router();

// OpenAI client setup (optional fallback to stub if no key)
let openai = null;
try {
  const { OpenAI } = require("openai");
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY,
  });
} catch (e) {
  console.warn("[chat] openai SDK not installed or misconfigured:", e.message);
}

/* ---------------------------------------------
   Helpers — plate extraction & normalization
---------------------------------------------- */
function normalizePlate(s = "") {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// International-friendly plate extractor
function extractPlateCandidatesInternational(text = "") {
  const t = String(text || "");
  const found = new Set();

  // Common segmented pattern: e.g. KDH 123A, AB-123-CD, KA 01 AB 1234
  const reSegmented = /\b([A-Za-z]{1,4})[\s.-]*([0-9]{1,4})[\s.-]*([A-Za-z]{1,4})\b/g;
  let m;
  while ((m = reSegmented.exec(t)) !== null) {
    const candidate = `${m[1]}${m[2]}${m[3]}`;
    const norm = normalizePlate(candidate);
    if (norm.length >= 4 && norm.length <= 10) found.add(norm);
  }

  // Two-part patterns like ABC 12345 or 123 ABC
  const reTwoPart = /\b([A-Za-z]{1,4})[\s.-]*([0-9]{2,5})\b|\b([0-9]{2,5})[\s.-]*([A-Za-z]{1,4})\b/g;
  while ((m = reTwoPart.exec(t)) !== null) {
    const part = (m[1] && m[2]) ? `${m[1]}${m[2]}` : `${m[3]}${m[4]}`;
    const norm = normalizePlate(part);
    if (norm.length >= 4 && norm.length <= 10) found.add(norm);
  }

  // Loose alphanumeric (e.g. 7ABC123, ABC1234)
  const reLoose = /\b([A-Za-z0-9][A-Za-z0-9\s.-]{2,12}[A-Za-z0-9])\b/g;
  while ((m = reLoose.exec(t)) !== null) {
    const norm = normalizePlate(m[1]);
    if (norm.length >= 4 && norm.length <= 10 && /[A-Z]/.test(norm) && /\d/.test(norm)) {
      found.add(norm);
    }
  }

  return Array.from(found);
}

/* ---------------------------------------------
   Helpers — make/model extraction
---------------------------------------------- */
function extractMakeModelGuess(text) {
  const lower = (text || "").toLowerCase();
  const makes = [
    "toyota","nissan","honda","mazda","subaru","ford","isuzu",
    "mercedes","benz","bmw","audi","vw","volkswagen","mitsubishi",
    "suzuki","hyundai","kia","chevrolet","peugeot","renault",
    "volvo","tata","jeep","range rover","land rover"
  ];
  const foundMake = makes.find(m => lower.includes(m));
  let model = null;
  if (foundMake) {
    const re = new RegExp(`${foundMake}\\s+([a-z0-9-]+)`, "i");
    const m = lower.match(re);
    if (m && m[1]) model = m[1];
  }
  return {
    make: foundMake ? foundMake.replace(/\b\w/g, c => c.toUpperCase()) : null,
    model: model || null
  };
}

/* ---------------------------------------------
   Optional DB helpers for dynamic knowledge
---------------------------------------------- */
async function tableExists(pool, schema, table) {
  const q = await pool.query(
    `SELECT to_regclass($1) AS oid`,
    [`${schema}.${table}`]
  );
  return !!q.rows?.[0]?.oid;
}

async function loadSubscriptionPlans(pool) {
  const exists = await tableExists(pool, "public", "subscription_plans");
  if (!exists) {
    // Fallback defaults if you haven't created the table yet
    return [
      { name: "Free",     price_currency: "KES", price_amount: 0,    billing_interval: "monthly", features: "1 vehicle, basic logs" },
      { name: "Basic",    price_currency: "KES", price_amount: 500,  billing_interval: "monthly", features: "Up to 3 vehicles, reminders" },
      { name: "Premium",  price_currency: "KES", price_amount: 1500, billing_interval: "monthly", features: "Unlimited vehicles, PDFs, exports" },
      { name: "FleetPro", price_currency: "KES", price_amount: 5000, billing_interval: "monthly", features: "Fleet dashboards, bulk ops, manager tools" },
    ];
  }
  const r = await pool.query(
    `SELECT name, price_currency, price_amount, billing_interval, features
       FROM public.subscription_plans
      ORDER BY COALESCE(sort_order, 9999), price_amount NULLS LAST, name ASC`
  );
  return r.rows;
}

async function loadAffiliateSettings(pool) {
  const exists = await tableExists(pool, "public", "affiliate_settings");
  if (!exists) {
    // Fallback defaults
    return { commission_rate: 0.15, payout_schedule: "monthly", min_payout: 1000, currency: "KES" };
  }
  const r = await pool.query(
    `SELECT commission_rate, payout_schedule, min_payout, currency
       FROM public.affiliate_settings
      ORDER BY id DESC
      LIMIT 1`
  );
  return r.rows[0] || { commission_rate: 0.15, payout_schedule: "monthly", min_payout: 1000, currency: "KES" };
}

/* ---------------------------------------------
   Main route
---------------------------------------------- */
router.post("/chat", async (req, res) => {
  try {
    const pool = req.app.get("pool");
    if (!pool) {
      return res.status(500).json({
        error: "Server error",
        detail: "Pool not found on app; set app.set('pool', pool) in index.js",
        path: req.originalUrl,
      });
    }

    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing 'messages' array" });
    }

    const userMsg = messages[messages.length - 1]?.content || "";
    let vehicle = null;

    // 1) Try normalized plate
    const plates = extractPlateCandidatesInternational(userMsg);
    if (plates.length) {
      for (const plate of plates) {
        const sql = `
          SELECT id, name, plate_number, type, make, model, year_of_manufacture
          FROM vehicles
          WHERE plate_normalized = upper(regexp_replace($1, '[^A-Za-z0-9]', '', 'g'))
          ORDER BY id DESC
          LIMIT 1
        `;
        const r = await pool.query(sql, [plate]);
        if (r.rows.length) { vehicle = r.rows[0]; break; }
      }
    }

    // 2) Fallback: make/model guess
    if (!vehicle) {
      const { make, model } = extractMakeModelGuess(userMsg);
      if (make || model) {
        const where = [];
        const params = [];
        let p = 1;

        if (make)  { where.push(`LOWER(make)=LOWER($${p++})`); params.push(make); }
        if (model) { where.push(`LOWER(model)=LOWER($${p++})`); params.push(model); }

        if (where.length) {
          const sql = `
            SELECT id, name, plate_number, type, make, model, year_of_manufacture
            FROM vehicles
            WHERE ${where.join(" AND ")}
            ORDER BY id DESC
            LIMIT 1
          `;
          const r = await pool.query(sql, params);
          if (r.rows.length) vehicle = r.rows[0];
        }
      }
    }

    // 3) Load dynamic data (plans + affiliate settings)
    const [plans, affiliate] = await Promise.all([
      loadSubscriptionPlans(pool),
      loadAffiliateSettings(pool)
    ]);

    // 4) Saka360 “domain brain” prompt
    const systemPrompt = [
      "You are Saka360's virtual assistant.",
      "Scope strictly to Saka360 features:",
      "- account signup/login, vehicle add/edit/delete",
      "- fuel/service logs, inspections, document uploads (insurance, inspection, etc.)",
      "- reminders (email/WhatsApp) and settings",
      "- subscriptions & payments",
      "- affiliate program (how to join, benefits, payout cadence)",
      "Never answer general web search questions.",
      "Keep answers short, clear, and oriented to actions inside Saka360."
    ].join(" ");

    const vehicleContext = vehicle
      ? `Matched vehicle: ${vehicle.make || ""} ${vehicle.model || ""} (${vehicle.plate_number || ""})`
      : "No specific vehicle matched.";

    const plansContext = plans && plans.length
      ? "Plans:\n" + plans.map(p =>
          `- ${p.name}: ${p.price_currency} ${p.price_amount}/${p.billing_interval}` +
          (p.features ? ` — ${p.features}` : "")
        ).join("\n")
      : "No subscription plans available.";

    const affiliateContext = affiliate
      ? `Affiliate: commission=${Math.round((affiliate.commission_rate || 0)*100)}%, schedule=${affiliate.payout_schedule}, min payout=${affiliate.currency} ${affiliate.min_payout}`
      : "Affiliate settings unavailable.";

    // 5) LLM call (or stub)
    let content = "(LLM not configured)";
    let provider = "stub";
    let model = "none";

    if (openai && (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY)) {
      provider = "openai";
      model = process.env.LLM_MODEL || "gpt-4o-mini";

      const completion = await openai.chat.completions.create({
        model,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "system", content: `Vehicle context: ${vehicleContext}` },
          { role: "system", content: plansContext },
          { role: "system", content: affiliateContext },
          ...messages
        ],
      });

      content = completion.choices?.[0]?.message?.content?.trim() || "(no response)";
    } else {
      content = [
        vehicle
          ? `Matched your vehicle ${vehicle.make || ""} ${vehicle.model || ""} (${vehicle.plate_number || ""}).`
          : `No specific vehicle matched.`,
        "Available subscription plans:",
        plansContext,
        "Affiliate program:",
        affiliateContext,
        "Ask me anything about using Saka360 (vehicles, logs, reminders, documents, payments, affiliate)."
      ].join("\n");
    }

    return res.json({ provider, model, content, vehicle: vehicle || null });
  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json({
      error: "Server error",
      detail: process.env.DEBUG_MODE === "1" ? err?.message : undefined,
      path: req.originalUrl,
    });
  }
});

module.exports = router;
