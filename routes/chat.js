// routes/chat.js
const express = require("express");
const router = express.Router();

// OpenAI client setup
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
   1️⃣ Helpers — plate extraction & normalization
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
    const part1 = (m[1] && m[2]) ? `${m[1]}${m[2]}` : `${m[3]}${m[4]}`;
    const norm = normalizePlate(part1);
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
   2️⃣ Helpers — make/model extraction
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
   3️⃣ Main route
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

    // 🔍 1. Try normalized plate search first
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
        if (r.rows.length) {
          vehicle = r.rows[0];
          break;
        }
      }
    }

    // 🔍 2. Try make/model fallback
    if (!vehicle) {
      const { make, model } = extractMakeModelGuess(userMsg);
      if (make || model) {
        const where = [];
        const params = [];
        let p = 1;

        if (make) { where.push(`LOWER(make)=LOWER($${p++})`); params.push(make); }
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

    // 🧠 3. Saka360 “domain brain” prompt
    const systemPrompt = [
      "You are Saka360's virtual assistant.",
      "You help users manage everything within the Saka360 ecosystem:",
      "- registering or logging into their account",
      "- adding, editing or deleting vehicles",
      "- recording fuel, service, and maintenance logs",
      "- viewing and downloading vehicle documents",
      "- understanding their subscription packages (Free, Basic, Premium, FleetPro)",
      "- handling payments and renewals",
      "- setting reminders for insurance, inspections, services, etc.",
      "- onboarding to the affiliate program (earning from referrals)",
      "- and any other in-app or account-related questions.",
      "Never answer questions outside this scope (no general web searches).",
      "Always keep answers concise, friendly, and helpful, guiding the user toward actions inside the Saka360 app."
    ].join(" ");

    const vehicleContext = vehicle
      ? `Matched vehicle:\n- ${vehicle.make || ""} ${vehicle.model || ""} (${vehicle.plate_number || ""})`
      : "No specific vehicle matched.";

    // 🧩 4. Call LLM
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
          { role: "system", content: `Vehicle context:\n${vehicleContext}` },
          ...messages
        ],
      });

      content = completion.choices?.[0]?.message?.content?.trim() || "(no response)";
    } else {
      content = vehicle
        ? `Matched your vehicle ${vehicle.make || ""} ${vehicle.model || ""} (${vehicle.plate_number || ""}). Ask anything related to maintenance, payments, packages or records.`
        : `You asked: "${userMsg}". I can help you with vehicle records, reminders, payments, or Saka360 features — try mentioning your plate or make.`;
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
