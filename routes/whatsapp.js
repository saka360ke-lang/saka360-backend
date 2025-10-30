// routes/whatsapp.js
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");

const router = express.Router();

/** ---------- ENV ----------
 * TWILIO_AUTH_TOKEN      : for signature verification
 * TWILIO_ACCOUNT_SID     : for fetching media (basic auth)
 * TWILIO_AUTH_TOKEN      : same as above
 * S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 */

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const S3_REGION = process.env.S3_REGION;
const S3_BUCKET = process.env.S3_BUCKET;

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  }
});

// Twilio signature verification middleware
function verifyTwilioSignature(req, res, next) {
  try {
    const signature = req.get("x-twilio-signature");
    const url = (process.env.PUBLIC_BASE_URL || "") + req.originalUrl; 
    // If you don't have PUBLIC_BASE_URL set, fallback to guessing Render's URL:
    // e.g. https://saka360-backend.onrender.com + req.originalUrl
    const base = process.env.PUBLIC_BASE_URL || "https://saka360-backend.onrender.com";
    const fullUrl = base.replace(/\/$/, "") + req.originalUrl;

    // Twilio signature: HMAC-SHA1 of URL + sorted form params
    // For simplicity, we'll use Twilio helper style: concatenate URL with
    // sorted POST params by key (no separators), then HMAC-SHA1 w/ auth token.
    const params = { ...req.body };
    const sortedKeys = Object.keys(params).sort();
    let data = fullUrl;
    for (const k of sortedKeys) data += k + params[k];

    const computed = crypto.createHmac("sha1", TWILIO_AUTH_TOKEN)
      .update(Buffer.from(data, "utf-8"))
      .digest("base64");

    if (!signature || signature !== computed) {
      // In early dev you can comment this out to simplify testing
      // return res.status(403).send("Invalid Twilio signature");
    }
    next();
  } catch (e) {
    // On dev, don't block; just log
    console.error("[twilio-signature] warn:", e.message);
    next();
  }
}

// Helper: respond back via TwiML
function twimlMessage(res, body) {
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(body)}</Message>
</Response>`
  );
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Normalize plate (remove spaces/dashes, uppercase)
function normalizePlate(s) {
  return (s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// Try to find or create a user by WhatsApp number
async function getOrCreateUserByWhatsApp(pool, waNumber) {
  // waNumber format from Twilio is like 'whatsapp:+2547XXXXXXX'
  const match = /\+?[0-9]{6,}/.exec(waNumber || "");
  const e164 = match ? match[0] : null;

  if (!e164) return null;

  const q = await pool.query(
    `SELECT id, name, email, whatsapp_number, role FROM users WHERE whatsapp_number = $1 LIMIT 1`,
    [e164]
  );
  if (q.rows.length) return q.rows[0];

  // Create a lightweight user stub
  const name = "WhatsApp User";
  const email = null; // no email yet
  const password_hash = null;
  const role = "user";

  const ins = await pool.query(
    `INSERT INTO users (name, email, whatsapp_number, password_hash, role, is_verified, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
     RETURNING id, name, email, whatsapp_number, role`,
    [name, email, e164, password_hash, role, true]
  );
  return ins.rows[0];
}

// Save Twilio media to S3 and return key
async function saveTwilioMediaToS3(mediaUrl, contentType, key) {
  // Twilio media requires basic auth with SID/TOKEN
  const resp = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN }
  });

  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: Buffer.from(resp.data),
    ContentType: contentType || "application/octet-stream"
  }));

  return key;
}

module.exports = (app) => {
  const pool = app.get("pool");
  if (!pool) {
    console.error("[whatsapp] missing pool on app");
  }

  // Twilio sends x-www-form-urlencoded
  router.post("/", verifyTwilioSignature, express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const from = req.body.From;           // e.g. 'whatsapp:+2547...'
      const body = (req.body.Body || "").trim();
      const numMedia = parseInt(req.body.NumMedia || "0", 10);

      const user = await getOrCreateUserByWhatsApp(pool, from);
      if (!user) return twimlMessage(res, "Sorry, could not identify your WhatsApp number.");

      // Media upload flow (insurance, logbook, etc.)
      if (numMedia > 0) {
        // Expect a hint in the text e.g. "insurance KDH 123A"
        // or we fallback to the latest vehicle
        const lower = body.toLowerCase();
        let plate = null;
        const plateMatch = lower.match(/[a-z]{3}\s*\d{3,4}[a-z]?/i);
        if (plateMatch) plate = normalizePlate(plateMatch[0]);

        // Try find a vehicle to attach this doc
        let vehicle = null;
        if (plate) {
          const vq = await pool.query(
            `SELECT * FROM vehicles
             WHERE user_id=$1 AND (UPPER(plate_number)=UPPER($2)
                   OR REPLACE(UPPER(plate_number), ' ', '')=UPPER($3))
             ORDER BY updated_at DESC NULLS LAST, created_at DESC
             LIMIT 1`,
            [user.id, plate, plate]
          );
          vehicle = vq.rows[0] || null;
        } else {
          const vq = await pool.query(
            `SELECT * FROM vehicles
             WHERE user_id=$1
             ORDER BY updated_at DESC NULLS LAST, created_at DESC
             LIMIT 1`,
            [user.id]
          );
          vehicle = vq.rows[0] || null;
        }

        // Pull the first media item
        const mediaUrl = req.body.MediaUrl0;
        const mediaContentType = req.body.MediaContentType0; // e.g. "image/jpeg" or "application/pdf"
        if (!mediaUrl) return twimlMessage(res, "No media found in the message.");

        // Choose a key
        const ext = mediaContentType?.includes("pdf") ? "pdf"
                  : mediaContentType?.includes("png") ? "png"
                  : mediaContentType?.includes("jpeg") ? "jpg"
                  : "bin";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const key = vehicle
          ? `docs/${user.id}/${vehicle.id}/${stamp}.${ext}`
          : `docs/${user.id}/unlinked/${stamp}.${ext}`;

        await saveTwilioMediaToS3(mediaUrl, mediaContentType, key);

        // Optionally create a record in files table (if you created it)
        try {
          await pool.query(
            `INSERT INTO files (user_id, bucket, s3_key, content_type, size_bytes, label)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [user.id, S3_BUCKET, key, mediaContentType, null, body || "WhatsApp upload"]
          );
        } catch (e) {
          console.error("[whatsapp] files insert warn:", e.message);
        }

        if (vehicle) {
          return twimlMessage(res, `✅ File saved to your ${vehicle.make || ""} ${vehicle.model || ""} (${vehicle.plate_number}). We’ll process it shortly.`);
        }
        return twimlMessage(res, `✅ File saved. Tip: include your plate in the caption next time, e.g. "insurance KDH123A".`);
      }

      // Text commands
      const cmd = body.toLowerCase();

      if (cmd === "help" || cmd === "menu") {
        return twimlMessage(res,
`Saka360 WhatsApp Help:
• add vehicle <plate> <make> <model> <year>
• my vehicles
• set reminders email on|off whatsapp on|off days <N>
• upload a document by sending a photo/PDF (caption with a plate helps)
• service 10,000 for <plate|make|model>
Examples:
- add vehicle KDH123A Toyota Probox 2015
- set reminders email on whatsapp on days 14`);
      }

      if (cmd.startsWith("add vehicle ")) {
        // add vehicle KDH123A Toyota Probox 2015
        const parts = body.split(/\s+/).slice(2); // after 'add' 'vehicle'
        const [plateRaw, make, model, year] = parts;
        if (!plateRaw || !make || !model) {
          return twimlMessage(res, "Usage: add vehicle <plate> <make> <model> <year>");
        }
        const plate = normalizePlate(plateRaw);
        const yr = year ? parseInt(year, 10) : null;

        // Upsert by plate
        const up = await pool.query(
          `INSERT INTO vehicles (user_id, name, plate_number, type, make, model, year_of_manufacture, created_at, updated_at, plate_normalized)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW(),$8)
           ON CONFLICT (user_id, plate_number) DO UPDATE
             SET make=EXCLUDED.make, model=EXCLUDED.model, year_of_manufacture=EXCLUDED.year_of_manufacture, updated_at=NOW(), plate_normalized=EXCLUDED.plate_normalized
           RETURNING id, name, plate_number, make, model, year_of_manufacture`,
          [user.id, `${make} ${model}`, plate, "car", make, model, yr, plate]
        );

        const v = up.rows[0];
        return twimlMessage(res, `✅ Saved: ${v.make} ${v.model} (${v.plate_number}) ${v.year_of_manufacture || ""}`);
      }

      if (cmd === "my vehicles") {
        const q = await pool.query(
          `SELECT plate_number, make, model, year_of_manufacture
           FROM vehicles WHERE user_id=$1
           ORDER BY updated_at DESC NULLS LAST, created_at DESC`,
          [user.id]
        );
        if (!q.rows.length) return twimlMessage(res, "You have no vehicles yet. Try: add vehicle KDH123A Toyota Probox 2015");
        const list = q.rows.map(v => `• ${v.make || ""} ${v.model || ""} (${v.plate_number}) ${v.year_of_manufacture || ""}`.trim()).join("\n");
        return twimlMessage(res, `Your vehicles:\n${list}`);
      }

      if (cmd.startsWith("set reminders")) {
        // set reminders email on whatsapp on days 14
        const emailOn = /email\s+on/i.test(body);
        const emailOff = /email\s+off/i.test(body);
        const waOn = /whatsapp\s+on/i.test(body);
        const waOff = /whatsapp\s+off/i.test(body);
        const daysMatch = body.match(/days\s+(\d{1,3})/i);
        const days = daysMatch ? Math.min(parseInt(daysMatch[1], 10), 90) : null;

        // Read existing
        const r0 = await pool.query(`SELECT * FROM reminder_settings WHERE user_id=$1 LIMIT 1`, [user.id]);
        let email_enabled = r0.rows[0]?.email_enabled ?? true;
        let whatsapp_enabled = r0.rows[0]?.whatsapp_enabled ?? true;
        let lead_days = r0.rows[0]?.lead_days ?? 14;

        if (emailOn) email_enabled = true;
        if (emailOff) email_enabled = false;
        if (waOn) whatsapp_enabled = true;
        if (waOff) whatsapp_enabled = false;
        if (days !== null) lead_days = days;

        const up = await pool.query(
          `INSERT INTO reminder_settings (user_id, email_enabled, whatsapp_enabled, lead_days, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (user_id) DO UPDATE
           SET email_enabled=EXCLUDED.email_enabled,
               whatsapp_enabled=EXCLUDED.whatsapp_enabled,
               lead_days=EXCLUDED.lead_days,
               updated_at=NOW()
           RETURNING email_enabled, whatsapp_enabled, lead_days`,
          [user.id, email_enabled, whatsapp_enabled, lead_days]
        );

        const s = up.rows[0];
        return twimlMessage(res, `✅ Reminders updated: email ${s.email_enabled ? "ON" : "OFF"}, WhatsApp ${s.whatsapp_enabled ? "ON" : "OFF"}, days ${s.lead_days}`);
      }

      // Example: service 10000 for KDH 123A / service 10,000 for Probox
      if (/^service\s+\d{3,6}/i.test(cmd)) {
        // Very basic demo—your /api/chat is richer; you can call it internally if you want.
        const kms = parseInt(cmd.replace(/[^\d]/g, ""), 10);
        return twimlMessage(res,
          `At ~${kms.toLocaleString()} km, consider: engine oil & filter, air filter, tire rotation & brake check, general inspection. Reply "help" for more.`);
      }

      // Fallback help
      return twimlMessage(res, `I didn’t catch that. Type "help" to see commands.`);
    } catch (err) {
      console.error("[whatsapp] error:", err);
      // Twilio requires a TwiML response; give a generic failure
      return twimlMessage(res, "Sorry, something went wrong.");
    }
  });

  app.use("/api/webhooks/whatsapp", router);
};
