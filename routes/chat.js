// routes/chat.js
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { chatComplete } = require("../utils/ai");

/** ---------- Helpers ---------- **/

// lowercase & trim
const norm = (s) => String(s || "").toLowerCase().trim();

// remove all non-alphanumerics (so "KDH 123A", "KDH-123A" => "kdh123a")
const normPlate = (s) => norm(s).replace(/[^a-z0-9]/g, "");

// quick tokenization to catch plates/words/years in user text
function tokensFromText(text) {
  const t = norm(text);
  const plateish = Array.from(t.matchAll(/[a-z0-9-]+/g))
    .map(m => normPlate(m[0]))
    .filter(Boolean)
    .filter(x => /[a-z]/.test(x) && /\d/.test(x)); // must have letters+digits
  const words = Array.from(t.matchAll(/[a-z]+/g)).map(m => m[0]);
  const years = Array.from(t.matchAll(/\b(19[6-9]\d|20[0-4]\d)\b/g)).map(m => m[0]);
  return { plateish, words, years };
}

function buildSelectList(cols) {
  return cols.map((c) => `"${c}"`).join(", ");
}

function vehicleLine(v, have) {
  const parts = [
    `id:${v.id}`,
    v.name && `name:${v.name}`,
    v.plate_number && `plate:${v.plate_number}`,
    v.type && `type:${v.type}`,
    have.make && v.make && `make:${v.make}`,
    have.model && v.model && `model:${v.model}`,
    have.year && v.year_of_manufacture && `year:${v.year_of_manufacture}`
  ].filter(Boolean);
  return parts.join(", ");
}

function shortVehicleLabel(v, have) {
  const bits = [
    v.name,
    v.plate_number && `(${v.plate_number})`,
    have.make && v.make,
    have.model && v.model,
    have.year && v.year_of_manufacture
  ].filter(Boolean);
  return bits.join(" ").replace(/\s+/g, " ").trim();
}

// basic “help intent” detector
function looksLikeHelp(text) {
  const t = norm(text);
  return [
    "how do i", "how to ", "where do i", "guide me", "show me", "steps", "record service",
    "add service", "add fuel", "log fuel", "upload", "document", "logbook",
    "insurance", "inspection", "reminder", "set reminder", "report", "download report"
  ].some(kw => t.includes(kw));
}

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool");

  router.post("/", authenticateToken, async (req, res) => {
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Missing 'messages' (array of {role, content})" });
      }

      // Combine user text
      const userText = messages.filter(m => m.role === "user").map(m => m.content || "").join(" ").trim();
      const { plateish, words, years } = tokensFromText(userText);

      // Detect optional columns
      const colQ = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='vehicles'
            AND column_name IN ('make','model','year_of_manufacture')`
      );
      const have = {
        make:  colQ.rows.some(r => r.column_name === "make"),
        model: colQ.rows.some(r => r.column_name === "model"),
        year:  colQ.rows.some(r => r.column_name === "year_of_manufacture"),
      };

      // Build select & fetch user's vehicles
      const baseFields = ["id", "name", "plate_number", "type"];
      if (have.make)  baseFields.push("make");
      if (have.model) baseFields.push("model");
      if (have.year)  baseFields.push("year_of_manufacture");

      const vq = await pool.query(
        `SELECT ${buildSelectList(baseFields)}
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

      // Precompute normalized plates
      const vehiclesWithNorm = vehicles.map(v => ({
        ...v,
        _plate_norm: v.plate_number ? normPlate(v.plate_number) : ""
      }));

      const textL = norm(userText);
      const textPlateNorms = [
        ...new Set([
          ...plateish,
          // also derive from raw text words by stripping non-alnum
          ...words.map(normPlate).filter(Boolean)
        ])
      ];

      // Match priority: exact plate (normalized) → fuzzy contains of plate norm → make/model narrowing → year
      let candidates = vehiclesWithNorm;

      // exact plate norm match first
      const exactByPlate = candidates.filter(v =>
        v._plate_norm && textPlateNorms.includes(v._plate_norm)
      );

      if (exactByPlate.length > 0) {
        candidates = exactByPlate;
      } else {
        // fuzzy: any user plate-ish token contained within vehicle plate norm or vice-versa
        const fuzzyPlate = candidates.filter(v =>
          v._plate_norm &&
          textPlateNorms.some(tp => v._plate_norm.includes(tp) || tp.includes(v._plate_norm))
        );
        if (fuzzyPlate.length > 0) candidates = fuzzyPlate;
      }

      // Narrow by make
      if (have.make) {
        const makesInText = new Set(
          vehiclesWithNorm
            .map(v => v.make)
            .filter(Boolean)
            .map(norm)
            .filter(mk => textL.includes(mk))
        );
        if (makesInText.size > 0) {
          candidates = candidates.filter(v => v.make && makesInText.has(norm(v.make)));
        }
      }

      // Narrow by model
      if (have.model) {
        const modelsInText = new Set(
          vehiclesWithNorm
            .map(v => v.model)
            .filter(Boolean)
            .map(norm)
            .filter(md => textL.includes(md))
        );
        if (modelsInText.size > 0) {
          candidates = candidates.filter(v => v.model && modelsInText.has(norm(v.model)));
        }
      }

      // Narrow by year
      if (have.year && years.length > 0) {
        const yset = new Set(years.map(y => parseInt(y, 10)));
        const narrowed = candidates.filter(v => v.year_of_manufacture && yset.has(Number(v.year_of_manufacture)));
        if (narrowed.length > 0) candidates = narrowed;
      }

      // Handle no match
      if (candidates.length === 0) {
        const examples = vehiclesWithNorm.slice(0, 5).map(v => shortVehicleLabel(v, have));
        return res.status(400).json({
          error: "No matching vehicle",
          detail:
            "I couldn’t find a vehicle matching what you typed. Mention the vehicle by plate (spaces/dashes OK), name, make, model, or year exactly as saved.",
          examples
        });
      }

      // Disambiguate multiples
      if (candidates.length > 1) {
        const options = candidates.slice(0, 6).map(v => ({
          id: v.id,
          label: shortVehicleLabel(v, have) || `Vehicle #${v.id}`
        }));
        return res.status(409).json({
          error: "Multiple vehicles match",
          options,
          tip: "Reply with one of the plate numbers (spaces/dashes OK), or make+model+year."
        });
      }

      // Exactly one
      const v = candidates[0];

      // --- HELP MODE: If user is asking “how to use Saka360”, give concise steps + API ---
      const helpMode = looksLikeHelp(userText);
      const helpBlock = helpMode ? [
        "Saka360 quick help (keep answers short, step-by-step):",
        "- To record a service: App → Vehicles → Select vehicle → Service → Add new → Fill description, cost, odometer → Save.",
        "- API (developer): POST /api/service/add { vehicle_id, description, cost, odometer } (Auth: Bearer).",
        "- To log fuel: App → Vehicles → Select vehicle → Fuel → Add new → Amount, price/liter, odometer → Save.",
        "- API: POST /api/fuel/add { vehicle_id, amount, price_per_liter, odometer }.",
        "- To upload a document (insurance, inspection, etc.): App → Documents → Upload → pick file → save.",
        "- API: Direct S3 upload via /api/uploads/sign-put then /api/uploads/finalize.",
        "- To set reminders: App → Documents → Set reminder ahead of expiry.",
        "- Reports: App → Reports → Fleet or Vehicle; API: GET /api/reports/vehicles/report/:vehicle_id."
      ].join("\n") : "";

      // External (kept empty now)
      const externalSummary = "";

      const systemPrompt = [
        "You are Saka360’s vehicle records assistant.",
        "Scope: only answer about the user’s own vehicles and maintenance. Keep answers short and practical.",
        "When listing items, use 3–7 bullet points. If uncertain, advise checking the owner’s manual.",
        `Vehicle in scope: ${vehicleLine(v, have)}`,
        helpBlock,
        externalSummary && "External maintenance notes:",
        externalSummary
      ].filter(Boolean).join("\n");

      const finalMessages = [
        { role: "system", content: systemPrompt },
        ...messages
      ];

      const ai = await chatComplete(finalMessages, { temperature: 0.2, max_tokens: 650 });

      return res.json({
        provider: ai.provider,
        model: ai.model || undefined,
        content: ai.content,
        vehicle: {
          id: v.id,
          name: v.name,
          plate_number: v.plate_number,
          type: v.type,
          make: have.make ? v.make : undefined,
          model: have.model ? v.model : undefined,
          year_of_manufacture: have.year ? v.year_of_manufacture : undefined,
        }
      });
    } catch (err) {
      console.error("chat route error:", err);
      return res.status(500).json({ error: "Chat failed", detail: err.message });
    }
  });

  app.use("/api/chat", router);
};
