// routes/chat.js
const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const { chatComplete } = require("../utils/ai");

/**
 * Helpers
 */
const norm = (s) => String(s || "").toLowerCase().trim();

function tokensFromText(text) {
  // extract crude tokens for plate-like (letters+digits), words, and years
  const t = norm(text);
  const plateish = Array.from(t.matchAll(/[a-z]{2,}\d{2,}[a-z]*|\d{2,}[a-z]+/g)).map(m => m[0]); // e.g., KDA123A, ABC123K
  const words = Array.from(t.matchAll(/[a-z]+/g)).map(m => m[0]); // toyota, probox
  const years = Array.from(t.matchAll(/\b(19[6-9]\d|20[0-4]\d)\b/g)).map(m => m[0]); // 1960-2049 safety
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

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool");

  router.post("/", authenticateToken, async (req, res) => {
    try {
      const messages = req.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: "Missing 'messages' (array of {role, content})" });
      }

      // Combine all user messages (we only inspect user's text for matching)
      const userText = messages.filter(m => m.role === "user").map(m => m.content || "").join(" ").trim();
      const { plateish, words, years } = tokensFromText(userText);

      // 1) Detect optional columns
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

      // 2) Build select & fetch user vehicles
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

      // 3) Try to match by (priority) plate → make/model → year narrowing
      const textL = norm(userText);

      const byPlate = vehicles.filter(v => v.plate_number && textL.includes(norm(v.plate_number)));
      // If the user typed something that looks like a plate but not exact match, try fuzzy contains
      const fuzzyPlate = vehicles.filter(v => v.plate_number && plateish.some(p => norm(v.plate_number).includes(p)));

      let candidates = byPlate.length ? byPlate : (fuzzyPlate.length ? fuzzyPlate : vehicles);

      // Narrow by make/model when present in text
      if (have.make) {
        const mks = new Set(
          vehicles
            .map(v => v.make)
            .filter(Boolean)
            .map(x => norm(x))
            .filter(x => textL.includes(x))
        );
        if (mks.size > 0) {
          candidates = candidates.filter(v => v.make && mks.has(norm(v.make)));
        }
      }

      if (have.model) {
        const mdls = new Set(
          vehicles
            .map(v => v.model)
            .filter(Boolean)
            .map(x => norm(x))
            .filter(x => textL.includes(x))
        );
        if (mdls.size > 0) {
          candidates = candidates.filter(v => v.model && mdls.has(norm(v.model)));
        }
      }

      // Narrow by year if present in query (rare but useful)
      if (have.year && years.length > 0) {
        const yset = new Set(years.map(y => parseInt(y, 10)));
        const narrowed = candidates.filter(v => v.year_of_manufacture && yset.has(Number(v.year_of_manufacture)));
        if (narrowed.length > 0) candidates = narrowed;
      }

      // If the query mentions plate/make/model/year tokens but we still match NOTHING → tell the user what to use
      if (candidates.length === 0) {
        // examples of valid handles
        const examples = vehicles.slice(0, 5).map(v => shortVehicleLabel(v, have));
        return res.status(400).json({
          error: "No matching vehicle",
          detail:
            "I couldn’t find a vehicle matching what you typed. Mention the vehicle by plate, name, make, model, or year exactly as saved.",
          examples
        });
      }

      // If multiple matches remain → ask user to pick one (short disambiguation)
      if (candidates.length > 1) {
        const options = candidates.slice(0, 6).map(v => ({
          id: v.id,
          label: shortVehicleLabel(v, have) || `Vehicle #${v.id}`
        }));
        return res.status(409).json({
          error: "Multiple vehicles match",
          options,
          tip: "Reply with one of the plate numbers, or make+model+year to narrow it down."
        });
      }

      // Exactly one vehicle found → build tight context
      const v = candidates[0];

      // Optional: load last few maintenance rows (fuel/service/docs) for richer context
      // Keeping it light/optional; comment these in if useful.
      // const [fuel, service, docs] = await Promise.all([
      //   pool.query(`SELECT amount, liters, odometer, created_at FROM fuel_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at DESC LIMIT 5`, [req.user.id, v.id]),
      //   pool.query(`SELECT description, cost, odometer, created_at FROM service_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at DESC LIMIT 5`, [req.user.id, v.id]),
      //   pool.query(`SELECT doc_type, number, expiry_date FROM documents WHERE user_id=$1 AND vehicle_id=$2 ORDER BY expiry_date ASC LIMIT 5`, [req.user.id, v.id]),
      // ]);

      // (Future) Web enrichment hook:
      // If you truly want “search the internet”, call your own small service here,
      // then add a compact summary string into the system prompt. Keep it short.
      // const externalSummary = await fetchBriefExternalSummary(v.make, v.model, v.year_of_manufacture);
      const externalSummary = ""; // keep empty for now (no external calls)

      const systemPrompt = [
        "You are Saka360’s vehicle records assistant.",
        "Answer briefly and practically (3–7 bullet points when listing).",
        "Use the exact vehicle details below. If a maintenance interval is general knowledge, state it clearly.",
        "If uncertain, say so and suggest checking the owner’s manual.",
        "",
        "Vehicle in scope:",
        `- ${vehicleLine(v, have)}`,
        externalSummary && "",
        externalSummary && "External maintenance summary:",
        externalSummary && externalSummary,
      ].filter(Boolean).join("\n");

      const finalMessages = [
        { role: "system", content: systemPrompt },
        // Optional: You can add a tool-style context message with last logs if you enabled the queries above.
        // { role: "system", content: `Recent logs: fuel=${fuel.rows.length}, service=${service.rows.length}, docs=${docs.rows.length}` },
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
      console.error("chat (plate/make/model flow) error:", err);
      return res.status(500).json({ error: "Chat failed", detail: err.message });
    }
  });

  // mount
  app.use("/api/chat", router);
};
