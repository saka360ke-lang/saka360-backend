// routes/whatsapp.js
const express = require("express");
const router = express.Router();

// Build TwiML reply
function twimlMessage(text) {
  const safe = (text || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function normalizeWhats(from) {
  return from ? from.replace(/^whatsapp:/, "") : null;
}

function normalizePlate(raw) {
  return raw ? raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : null;
}

const HELP = [
  "Saka360 WhatsApp Help:",
  "• add vehicle <plate> <make> <model> <year>",
  "• delete vehicle <plate>",
  "• my vehicles",
  "• set reminders email on|off whatsapp on|off days <N>",
  "• service <km> for <plate|make|model>",
  "",
  "Examples:",
  "- add vehicle KDH123A Toyota Probox 2015",
  "- delete vehicle KDH123A",
  "- set reminders email on whatsapp on days 14",
].join("\n");

// Loose parser for `add vehicle`
function parseAddVehicleLoose(body) {
  const m = body.match(/^add\s+vehicle\s+(.+)$/i);
  if (!m) return null;
  const rest = m[1].trim();

  // split by spaces; expect: plate make model [year?]
  const parts = rest.split(/\s+/);

  if (parts.length < 3) {
    // Not enough info; caller will show usage
    return { partial: true };
  }

  const plate = parts[0];
  let year = null;

  // If last token looks like year (4 digits), pop it
  if (/^\d{4}$/.test(parts[parts.length - 1])) {
    year = Number(parts.pop());
  }

  const make = parts[1];
  const model = parts.slice(2).join(" "); // allow multi-word models (e.g., Land Cruiser)

  return { plate, make, model, year };
}

// Exact “set reminders …” options (any subset allowed)
function parseSetReminders(body) {
  const r = { email_enabled: null, whatsapp_enabled: null, days_before: null };
  const lc = body.toLowerCase();

  if (/\bemail\s+on\b/.test(lc)) r.email_enabled = true;
  if (/\bemail\s+off\b/.test(lc)) r.email_enabled = false;

  if (/\bwhatsapp\s+on\b/.test(lc)) r.whatsapp_enabled = true;
  if (/\bwhatsapp\s+off\b/.test(lc)) r.whatsapp_enabled = false;

  const md = lc.match(/\bdays\s+(\d{1,3})\b/);
  if (md) r.days_before = Number(md[1]);

  if (r.email_enabled === null && r.whatsapp_enabled === null && r.days_before === null) return null;
  return r;
}

// “service 10000 for …” or “service 10000”
function parseService(body) {
  const m = body.match(/^service\s+(\d{3,6})(?:\s+for\s+(.+))?$/i);
  if (!m) return null;
  return { km: Number(m[1]), query: m[2]?.trim() || null };
}

// NEW: delete vehicle
function parseDeleteVehicle(body) {
  const m = body.match(/^delete\s+vehicle\s+(.+)$/i);
  if (!m) return null;
  return { plate: m[1].trim() };
}

module.exports = (app) => {
  const pool = app.get("pool");
  if (!pool) throw new Error("DB pool missing; ensure app.set('pool', pool) in index.js");

  router.post("/webhook", async (req, res) => {
    try {
      const from = normalizeWhats(req.body.From);
      const body = (req.body.Body || "").trim();

      if (!from || !body) {
        return res.type("text/xml").send(twimlMessage("Sorry, I couldn't read that. Type 'help' to see commands."));
      }

      // Find or create user by WhatsApp
      let user;
      {
        const q = await pool.query(
          `SELECT id, name, email, whatsapp_number FROM users WHERE whatsapp_number = $1 LIMIT 1`,
          [from]
        );
        if (q.rows.length) user = q.rows[0];
        else {
          const ins = await pool.query(
            `INSERT INTO users (name, email, whatsapp_number, role, is_verified, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
             RETURNING id, name, email, whatsapp_number`,
            ["WhatsApp User", null, from, "user", true]
          );
          user = ins.rows[0];
        }
      }

      const lc = body.toLowerCase();

      // HELP
      if (lc === "help" || lc === "menu") {
        return res.type("text/xml").send(twimlMessage(HELP));
      }

      // MY VEHICLES
      if (lc === "my vehicles" || lc === "vehicles") {
        const v = await pool.query(
          `SELECT name, plate_number, make, model, year_of_manufacture
             FROM vehicles WHERE user_id = $1
             ORDER BY created_at ASC`,
          [user.id]
        );
        if (!v.rows.length) {
          return res.type("text/xml").send(twimlMessage(
            "You have no vehicles yet.\nAdd one:\nadd vehicle <plate> <make> <model> <year>"
          ));
        }
        const lines = v.rows.map(r => {
          const title = r.name || `${r.make||""} ${r.model||""}`.trim();
          const y = r.year_of_manufacture ? ` ${r.year_of_manufacture}` : "";
          return `• ${title} (${r.plate_number})${y}`;
        });
        return res.type("text/xml").send(twimlMessage(["Your vehicles:", ...lines].join("\n")));
      }

      // ADD VEHICLE (loose)
      if (lc.startsWith("add vehicle") || lc === "add") {
        const parsed = parseAddVehicleLoose(body);
        if (!parsed || parsed.partial) {
          return res.type("text/xml").send(twimlMessage(
            "Format:\nadd vehicle <plate> <make> <model> <year>\nExample:\nadd vehicle KDH123A Toyota Probox 2015"
          ));
        }

        const plateNorm = normalizePlate(parsed.plate);
        // dupe check for this user
        const exists = await pool.query(
          `SELECT id FROM vehicles
            WHERE user_id=$1
              AND UPPER(REGEXP_REPLACE(plate_number,'[^A-Za-z0-9]','','g')) = $2
            LIMIT 1`,
          [user.id, plateNorm]
        );
        if (exists.rows.length) {
          return res.type("text/xml").send(twimlMessage(`That vehicle is already in your list (${parsed.plate}).`));
        }

        const name = `${parsed.make} ${parsed.model}`.trim();
        await pool.query(
          `INSERT INTO vehicles (user_id, name, plate_number, type, make, model, year_of_manufacture, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
          [user.id, name, parsed.plate.toUpperCase(), "car", parsed.make, parsed.model, parsed.year]
        );
        return res.type("text/xml").send(twimlMessage(
          `Added ✅ ${name} (${parsed.plate.toUpperCase()})${parsed.year ? " " + parsed.year : ""}`
        ));
      }

      // DELETE VEHICLE
      if (lc.startsWith("delete vehicle")) {
        const p = parseDeleteVehicle(body);
        if (!p?.plate) {
          return res.type("text/xml").send(twimlMessage("Format:\ndelete vehicle <plate>\nExample:\ndelete vehicle KDH123A"));
        }
        const plateNorm = normalizePlate(p.plate);
        const del = await pool.query(
          `DELETE FROM vehicles
            WHERE user_id=$1
              AND UPPER(REGEXP_REPLACE(plate_number,'[^A-Za-z0-9]','','g')) = $2
            RETURNING id, plate_number`,
          [user.id, plateNorm]
        );
        if (!del.rows.length) {
          return res.type("text/xml").send(twimlMessage(`No vehicle found with plate ${p.plate}.`));
        }
        return res.type("text/xml").send(twimlMessage(`Deleted ✅ ${del.rows[0].plate_number}.`));
      }

      // SET REMINDERS (+ singular “set reminder” show current)
      if (lc.startsWith("set reminders") || lc === "set reminder" || lc === "reminder settings") {
        const pr = parseSetReminders(body);
        if (!pr) {
          // Show current settings if any
          const rs = await pool.query(
            `SELECT email_enabled, whatsapp_enabled, days_before
               FROM reminder_settings WHERE user_id=$1 LIMIT 1`,
            [user.id]
          );
          if (!rs.rows.length) {
            return res.type("text/xml").send(twimlMessage(
              "No settings saved.\nExample:\nset reminders email on whatsapp on days 14"
            ));
          }
          const s = rs.rows[0];
          return res.type("text/xml").send(twimlMessage(
            `Current settings:\nEmail: ${s.email_enabled ? "on" : "off"}\nWhatsApp: ${s.whatsapp_enabled ? "on" : "off"}\nDays before: ${s.days_before}`
          ));
        }

        await pool.query(
          `INSERT INTO reminder_settings(user_id, email_enabled, whatsapp_enabled, days_before, updated_at)
           VALUES($1,$2,$3,$4,NOW())
           ON CONFLICT(user_id) DO UPDATE
             SET email_enabled = COALESCE(EXCLUDED.email_enabled, reminder_settings.email_enabled),
                 whatsapp_enabled = COALESCE(EXCLUDED.whatsapp_enabled, reminder_settings.whatsapp_enabled),
                 days_before = COALESCE(EXCLUDED.days_before, reminder_settings.days_before),
                 updated_at = NOW()`,
          [user.id, pr.email_enabled, pr.whatsapp_enabled, pr.days_before]
        );
        return res.type("text/xml").send(twimlMessage("Saved ✅ reminder preferences."));
      }

      // SERVICE (as before)
      const svc = parseService(body);
      if (svc) {
        let vehicle = null;
        if (svc.query) {
          const plateNorm = normalizePlate(svc.query);
          const qv = await pool.query(
            `SELECT id, name, plate_number, make, model, year_of_manufacture
               FROM vehicles
              WHERE user_id=$1 AND (
                    UPPER(REGEXP_REPLACE(plate_number,'[^A-Za-z0-9]','','g'))=$2
                 OR  LOWER(make)=LOWER($3)
                 OR  LOWER(model)=LOWER($3)
              )
              ORDER BY created_at ASC
              LIMIT 1`,
            [user.id, plateNorm, svc.query]
          );
          if (qv.rows.length) vehicle = qv.rows[0];
        } else {
          const qv = await pool.query(
            `SELECT id, name, plate_number, make, model, year_of_manufacture
               FROM vehicles WHERE user_id=$1 ORDER BY created_at ASC LIMIT 1`,
            [user.id]
          );
          if (qv.rows.length) vehicle = qv.rows[0];
        }

        const base = [
          `Service @ ${svc.km.toLocaleString()} km:`,
          "- Engine oil & filter",
          "- Air filter (inspect/replace)",
          "- Brake inspection (pads/rotors)",
          "- Tire rotation, pressure & tread",
          "- Fluids top-up, belts/hoses check",
        ];
        const suffix = vehicle
          ? `\nVehicle: ${vehicle.make || ""} ${vehicle.model || ""} (${vehicle.plate_number})`
          : "\nTip: add a vehicle so I can personalize intervals.";
        return res.type("text/xml").send(twimlMessage(base.join("\n") + suffix));
      }

      return res.type("text/xml").send(twimlMessage('I didn’t catch that. Type "help" to see commands.'));
    } catch (err) {
      console.error("whatsapp webhook error:", err);
      return res.type("text/xml").send(twimlMessage("Sorry, something went wrong"));
    }
  });

  app.use("/api/whatsapp", router);
};
