// utils/reminders.js
//
// Daily reminder engine that respects per-user reminder_settings.
// It creates "due" reminders and sends them by Email / WhatsApp,
// then marks them as sent.
//
// Expects:
//  - Postgres tables: documents(user_id, vehicle_id, doc_type, expiry_date, ...),
//                     vehicles(id, user_id, name, plate_number, ...),
//                     reminder_settings(user_id, email_enabled, email_days_before, whatsapp_enabled, whatsapp_days_before),
//                     reminders(id, user_id, document_id, vehicle_id, reminder_date, channel, sent, sent_at, created_at)
//  - A mail sender: async function sendEmail(to, subject, template, data)
//  - A WhatsApp sender: async function sendWhatsAppTextSafe(toE164, body) (never throws)
//
// You already mounted routes/reminders.js which exposes /api/reminders/... and settings CRUD.

const { format } = require("date-fns");

// -------------------------------
// helpers
// -------------------------------
function daysBefore(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return d;
}

function isSameOrBefore(a, b) {
  return a.getTime() <= b.getTime();
}

// One-shot insert-or-get id for a reminder (document_id + date + channel)
async function upsertReminder(pool, { userId, documentId, vehicleId, reminderDate, channel }) {
  const q = await pool.query(
    `INSERT INTO reminders (user_id, document_id, vehicle_id, reminder_date, channel, sent, created_at)
     VALUES ($1,$2,$3,$4,$5,false,NOW())
     ON CONFLICT (document_id, reminder_date, channel) DO UPDATE
       SET user_id = EXCLUDED.user_id, vehicle_id = EXCLUDED.vehicle_id
     RETURNING id, sent`,
    [userId, documentId, vehicleId, reminderDate, channel]
  );
  return q.rows[0]; // { id, sent }
}

async function fetchUserSettings(pool, userId) {
  const r = await pool.query(
    `SELECT user_id, email_enabled, email_days_before, whatsapp_enabled, whatsapp_days_before
       FROM reminder_settings
      WHERE user_id = $1`,
    [userId]
  );
  if (r.rows.length === 0) {
    // default row if missing
    await pool.query(`INSERT INTO reminder_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    return {
      user_id: userId,
      email_enabled: true,
      email_days_before: 14,
      whatsapp_enabled: false,
      whatsapp_days_before: 7
    };
  }
  return r.rows[0];
}

function fmt(d) {
  return format(new Date(d), "dd MMM yyyy");
}

// -------------------------------
// MAIN entry
// -------------------------------
/**
 * Run the daily expiry check:
 * - read all documents with a future expiry_date
 * - for each user, read reminder_settings
 * - compute (expiry - N days) per channel
 * - create a reminder row if not exists
 * - if reminder_date is today or past and not sent -> send & mark sent
 */
async function runExpiryCheckCore(pool, senders) {
  const { sendEmail, sendWhatsAppTextSafe } = senders; // both should exist

  const today = new Date();

  // Pull upcoming docs (e.g., expiring in next 90 days; adjust as needed)
  const docs = await pool.query(
    `SELECT d.id AS document_id, d.user_id, d.vehicle_id, d.doc_type, d.number, d.expiry_date,
            u.email, u.name AS user_name, u.whatsapp_number,
            v.name AS vehicle_name, v.plate_number
       FROM documents d
       JOIN users u ON u.id = d.user_id
  LEFT JOIN vehicles v ON v.id = d.vehicle_id
      WHERE d.expiry_date IS NOT NULL
        AND d.expiry_date >= NOW()
        AND d.expiry_date <= NOW() + INTERVAL '90 days'
      ORDER BY d.expiry_date ASC`
  );

  for (const row of docs.rows) {
    const {
      document_id, user_id, vehicle_id, doc_type, number, expiry_date,
      email, user_name, whatsapp_number, vehicle_name, plate_number
    } = row;

    const settings = await fetchUserSettings(pool, user_id);

    // Build channels to consider
    const channels = [];
    if (settings.email_enabled) {
      channels.push({ channel: "email", days_before: settings.email_days_before });
    }
    if (settings.whatsapp_enabled) {
      channels.push({ channel: "whatsapp", days_before: settings.whatsapp_days_before });
    }

    for (const ch of channels) {
      const reminderDate = daysBefore(expiry_date, ch.days_before);

      // Create or fetch reminder row
      const r = await upsertReminder(pool, {
        userId: user_id,
        documentId: document_id,
        vehicleId: vehicle_id,
        reminderDate,
        channel: ch.channel
      });

      // Only send if reminder date is due and not already sent
      if (!r.sent && isSameOrBefore(reminderDate, today)) {
        // Send
        if (ch.channel === "email" && email) {
          try {
            await sendEmail(
              email,
              `Reminder: ${doc_type} expires ${fmt(expiry_date)}`,
              // reuse a simple template you already have (or fallback to plain)
              // If you don't have a special template, pass null and a plain text body:
              null,
              `Hi ${user_name || "there"},\n\nYour ${doc_type}${number ? ` (${number})` : ""} for ${vehicle_name || plate_number || "your vehicle"} expires on ${fmt(expiry_date)}.\n\nPlease renew in time.`
            );
          } catch (e) {
            console.error(`reminder email error (user ${user_id})`, e.message);
          }
        }

        if (ch.channel === "whatsapp" && whatsapp_number) {
          try {
            await sendWhatsAppTextSafe(
              whatsapp_number,
              `Reminder: ${doc_type}${number ? ` (${number})` : ""} for ${vehicle_name || plate_number || "your vehicle"} expires on ${fmt(expiry_date)}.`
            );
          } catch (e) {
            console.error(`reminder whatsapp error (user ${user_id})`, e.message);
          }
        }

        // Mark sent
        await pool.query(`UPDATE reminders SET sent = true, sent_at = NOW() WHERE id = $1`, [r.id]);
      }
    }
  }

  return { ok: true, processed: docs.rowCount };
}

module.exports = { runExpiryCheckCore };
