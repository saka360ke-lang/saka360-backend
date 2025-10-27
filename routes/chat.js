// routes/chat.js
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { chatComplete } = require("../utils/ai");

function normalize(s) {
  return String(s || "").toLowerCase().trim();
}

// Simple keyword presence check
function containsAny(haystack, needles) {
  const hay = ` ${normalize(haystack)} `;
  return needles.some(n => {
    const key = normalize(n);
    return key && hay.includes(` ${key} `);
  });
}

// Try to find which vehicles are being referenced in the user text
function matchVehicles(userText, vehicles, candidateFields) {
  const hay = normalize(userText);
  const hits = [];
  for (const v of vehicles) {
    const keys = [];
    for (const f of candidateFields) {
      const val = v[f];
      if (val === null || val === undefined) continue;
      // year_of_manufacture: stringify
      if (f === "year_of_manufacture") {
        keys.push(String(val));
      } else {
        keys.push(String(val));
      }
    }
    // if any field of this vehicle appears in the text, it's a hit
    if (containsAny(hay, keys)) {
      hits.push({ vehicle: v, matched_on: keys.filter(k => hay.includes(normalize(k))) });
    }
  }
  return hits;
}

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool"); // shared pool

  /**
   * POST /api/chat
   * Body: { messages: [{role, content}, ...] }
   * Auth: Bearer token
   * Behavior:
   *  - Auto-detect presence of make/model/year_of_manufacture columns
   *  - Limit scope to user's vehicles; require query to reference name/plate/type/make/model/year
   *  - If a specific vehicle is referenced, pass full context for that vehicle to the LLM
   */
  router.post("/", authenticateToken, async (req, res) => {
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Missing 'messages' (array of {role, content})" });
      }
      const userText = messages.filter(m => m.role === "user").map(m => m.content || "").join(" ").trim();

      // 1) Detect optional columns
      const colQ = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='vehicles'
            AND column_name IN ('make','model','year_of_manufacture')`
      );

      const haveMake  = colQ.rows.some(r => r.column_name === "make");
      const haveModel = colQ.rows.some(r => r.column_name === "model");
      const haveYear  = colQ.rows.some(r => r.column_name === "year_of_manufacture");

      // 2) Build SELECT list dynamically (always include id/name/plate_number/type)
      const baseFields = ["id", "name", "plate_number", "type"];
      if (haveMake)  baseFields.push("make");
      if (haveModel) baseFields.push("model");
      if (haveYear)  baseFields.push("year_of_manufacture");

      const selectList = baseFields.map(f => `"${f}"`).join(", ");

      // 3) Fetch vehicles for this user
      const vq = await pool.query(
        `SELECT ${selectList}
           FROM public.vehicles
          WHERE user_id = $1
          ORDER BY created_at ASC NULLS LAST, id ASC`,
        [req.user.id]
      );
      const vehicles = vq.rows;

      if (vehicles.length === 0) {
        return res.status(400).json({
          error: "No vehicles found",
          detail: "Add at least one vehicle before using the assistant."
        });
      }

      // 4) Build allowed keywords set (name, plate, type, make, model, year)
      const allowFields = ["name", "plate_number", "type"];
      if (haveMake)  allowFields.push("make");
      if (haveModel) allowFields.push("model");
      if (haveYear)  allowFields.push("year_of_manufacture");

      const allowedKeywords = [];
      for (const v of vehicles) {
        for (const f of allowFields) {
          const val = v[f];
          if (val !== null && val !== undefined && String(val).trim() !== "") {
            allowedKeywords.push(String(val));
          }
        }
      }

      // 5) Hard scope: user must mention at least one known identifier
      if (!containsAny(userText, allowedKeywords)) {
        return res.status(400).json({
          error: "Out-of-scope",
          detail:
            "Please mention one of your vehicles by name, plate number, make, model, or year (as saved in your account).",
          examples: vehicles.slice(0, 5).map(v => {
            const parts = [
              v.name && `name: ${v.name}`,
              v.plate_number && `plate: ${v.plate_number}`,
              v.type && `type: ${v.type}`,
              haveMake && v.make && `make: ${v.make}`,
              haveModel && v.model && `model: ${v.model}`,
              haveYear && v.year_of_manufacture && `year: ${v.year_of_manufacture}`
            ].filter(Boolean);
            return parts.join(" | ");
          })
        });
      }

      // 6) Identify which vehicles were referenced
      const hits = matchVehicles(userText, vehicles, allowFields);
      const matchedVehicles = hits.map(h => h.vehicle);

      // 7) Build a compact context block for the LLM
      function vehicleLine(v) {
        const parts = [
          `id:${v.id}`,
          v.name && `name:${v.name}`,
          v.plate_number && `plate:${v.plate_number}`,
          v.type && `type:${v.type}`,
          haveMake && v.make && `make:${v.make}`,
          haveModel && v.model && `model:${v.model}`,
          haveYear && v.year_of_manufacture && `year:${v.year_of_manufacture}`
        ].filter(Boolean);
        return parts.join(", ");
      }

      const contextLines = (matchedVehicles.length > 0 ? matchedVehicles : vehicles).map(vehicleLine);

      const scopeSystemPrompt = [
        "You are Saka360’s vehicle records assistant.",
        "Strict rules:",
        "1) Only answer questions about the user's vehicles listed below.",
        "2) If the user’s question is not about a listed vehicle, ask them to mention the vehicle name, plate, make, model, or year from their account.",
        "3) Give concise, actionable, Kenya-friendly advice for maintenance intervals and record-keeping.",
        "",
        `Vehicles in scope (${matchedVehicles.length > 0 ? "filtered selection" : "all user vehicles"}):`,
        ...contextLines.map(l => `- ${l}`),
        "",
        "When suggesting service items at a given mileage, include: what to check/replace, quick reasoning, typical interval, and any Kenyan road/terrain considerations.",
      ].join("\n");

      const finalMessages = [
        { role: "system", content: scopeSystemPrompt },
        ...messages
      ];

      const ai = await chatComplete(finalMessages, { temperature: 0.2, max_tokens: 700 });

      return res.json({
        provider: ai.provider,
        model: ai.model || undefined,
        content: ai.content,
        matched_vehicle_count: matchedVehicles.length,
        used_columns: { make: haveMake, model: haveModel, year_of_manufacture: haveYear }
      });
    } catch (err) {
      console.error("chat (make/model aware) error:", err);
      return res.status(500).json({ error: "Chat failed", detail: err.message });
    }
  });

  // mount
  app.use("/api/chat", router);
};
