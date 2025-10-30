// routes/whatsapp.js
const express = require("express");
const router = express.Router();

/** Build a TwiML reply (so we don't need to send via API) */
function twimlMessage(text) {
  const safe = (text || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function normalizeWhats(from) {
  // Twilio sends like: "whatsapp:+2547XXXXXXX"
  if (!from) return null;
  return from.replace(/^whatsapp:/, "");
}

function normalizePlate(raw) {
  if (!raw) return null;
  return raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase(); // remove spaces/dashes, keep letters+digits
}

/** Parse:  add vehicle <plate> <make> <model> <year> */
function parseAddVehicle(body) {
  // example: "add vehicle KDH123A Toyota Probox 2015"
  const m = body.match(/^add\s+vehicle\s+(\S+)\s+([A-Za-z0-9\-]+)\s+([A-Za-z0-9\-]+)\s+(\d{4})$/i);
  if (!m) return null;
  return { plate: m[1], make: m[2], model: m[3], year: Number(m[4]) };
}

/** Parse: set reminders email on|off whatsapp on|off days N */
function parseSetReminders(body) {
  // flexible: allow missing pieces
  // examples:
  //   set reminders email on whatsapp on days 14
  //   set reminders email off days 7
  //   set reminders whatsapp on
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

/** Parse: service <km> for <query>  OR  service <km>  */
function parseService(body) {
  // examples:
  //   service 10000 for KDH123A
  //   service 15000 for Toyota
  //   service 10000
  const m = body.match(/^service\s+(\d{3,6})(?:\s+for\s+(.+))?$/i);
  if (!m) return null;
  return { km: Number(m[1]), query: m[2]?.trim() || null };
}

/** Help text */
const HELP = [
  "Saka360 WhatsApp Help:",
  "• add vehicle <plate> <make> <model> <year>",
  "• my vehicles",
  "• set reminders email on|off whatsapp on|off days <N>",
  "• service <km> for <plate|make|model>",
  "",
  "Examples:",
  "- add vehicle KDH123A Toyota Probox 2015",
  "- set reminders email on whatsapp on days 14",
].join("\n");

module.exports = (app) => {
  const pool = app.get("pool");
  if (!pool) throw new Error("DB pool missing; ensure app.set('pool', pool) in index.js");

  router.post("/webhook", async (req, res) => {
    try {
      const from = normalizeWhats(req.body.From);
      const body = (req.body.Body || "").trim();

      if (!from || !body) {
        return res.type("text/xml").send(twimlMessage("Sorry, I couldn't read your message. Type 'help' to see commands."));
      }

      // Find (or create minimal) user by whatsapp_number
      let user = null;
      {
        const q = await pool.query(
          `SELECT id, name, email, whatsapp_number FROM users WHERE whatsapp_number = $1 LIMIT 1`,
          [from]
        );
        if (q.rows.length) {
          user = q.rows[0];
        } else {
          // Soft-onboard: create a minimal user so they can add vehicles
          const ins = await pool.query(
            `INSERT INTO users (name, email, whatsapp_number, role, is_verified, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
             RETURNING id, name, email, whatsapp_number`,
            ["WhatsApp User", null, from, "user", true]
          );
          user = ins.rows[0];
        }
      }

      // Commands
      const lc = body.toLowerCase();

      // 1) HELP
      if (lc === "help") {
        return res.type("text/xml").send(twimlMessage(HELP));
      }

      // 2) MY VEHICLES
      if (lc === "my vehicles") {
        const v = await pool.query(
          `SELECT name, plate_number, make, model, year_of_manufacture
             FROM vehicles WHERE user_id = $1 ORDER BY created_at ASC`,
          [user.id]
        );
        if (!v.rows.length) {
          return res.type("text/xml").send(twimlMessage("You have no vehicles yet.\nAdd one:\nadd vehicle <plate> <make> <model> <year>"));
        }
        const lines = v.rows.map(r => {
          const y = r.year_of_manufacture ? ` ${r.year_of_manufacture}` : "";
          return `• ${r.name || `${r.make||""} ${r.model||""}`.trim()} (${r.plate_number})${y}`;
        });
        return res.type("text/xml").send(twimlMessage(["Your vehicles:", ...lines].join("\n")));
      }

      // 3) ADD VEHICLE
      const addParsed = parseAddVehicle(body);
      if (addParsed) {
        const plateNorm = normalizePlate(addParsed.plate);
        // prevent dupes on same user
        const exists = await pool.query(
          `SELECT id FROM vehicles WHERE user_id=$1 AND UPPER(REGEXP_REPLACE(plate_number,'[^A-Za-z0-9]','','g')) = $2 LIMIT 1`,
          [user.id, plateNorm]
        );
        if (exists.rows.length) {
          return res.type("text/xml").send(twimlMessage(`That vehicle is already in your list (${addParsed.plate}).`));
        }

        const name = `${addParsed.make} ${addParsed.model}`.trim();
        await pool.query(
          `INSERT INTO vehicles (user_id, name, plate_number, type, make, model, year_of_manufacture, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
          [user.id, name, addParsed.plate.toUpperCase(), "car", addParsed.make, addParsed.model, addParsed.year]
        );
        return res.type("text/xml").send(twimlMessage(`Added ✅ ${name} (${addParsed.plate.toUpperCase()}) ${addParsed.year}`));
      }

      // 4) SET REMINDERS
      if (lc.startsWith("set reminders")) {
        const pr = parseSetReminders(body);
        if (!pr) {
          // Show current settings if present
          const rs = await pool.query(
            `SELECT email_enabled, whatsapp_enabled, days_before
               FROM reminder_settings WHERE user_id=$1 LIMIT 1`,
            [user.id]
          );
          if (!rs.rows.length) {
            return res.type("text/xml").send(twimlMessage(
              "No settings found. Example:\nset reminders email on whatsapp on days 14"
            ));
          }
          const s = rs.rows[0];
          return res.type("text/xml").send(twimlMessage(
            `Current settings:\nEmail: ${s.email_enabled ? "on" : "off"}\nWhatsApp: ${s.whatsapp_enabled ? "on" : "off"}\nDays before: ${s.days_before}`
          ));
        }

        // upsert
        await pool.query(
          `INSERT INTO reminder_settings(user_id, email_enabled, whatsapp_enabled, days_before, updated_at)
           VALUES($1,$2,$3,$4,NOW())
           ON CONFLICT(user_id) DO UPDATE
             SET email_enabled = COALESCE(EXCLUDED.email_enabled, reminder_settings.email_enabled),
                 whatsapp_enabled = COALESCE(EXCLUDED.whatsapp_enabled, reminder_settings.whatsapp_enabled),
                 days_before = COALESCE(EXCLUDED.days_before, reminder_settings.days_before),
                 updated_at = NOW()`,
          [
            user.id,
            pr.email_enabled,
            pr.whatsapp_enabled,
            pr.days_before
          ]
        );
        return res.type("text/xml").send(twimlMessage("Saved ✅ reminder preferences."));
      }

      // 5) SERVICE <km> [for …]
      const svc = parseService(body);
      if (svc) {
        // Try resolve a vehicle when query given; else use the first
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

      // Default
      return res.type("text/xml").send(twimlMessage("I didn’t catch that. Type \"help\" to see commands."));
    } catch (err) {
      console.error("whatsapp webhook error:", err);
      return res.type("text/xml").send(twimlMessage("Sorry, something went wrong"));
    }
  });

  app.use("/api/whatsapp", router); // webhook at /api/whatsapp/webhook
};
