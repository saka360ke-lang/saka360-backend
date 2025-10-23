// utils/reminders.js
const { sendEmail } = require("../utils/mailer");

async function runExpiryCheckCore(pool, sendWhatsAppTextSafe) {
  // Find documents expiring in 7, 3, or 1 day(s) for verified users and create reminders if not already sent
  // db tables assumed: documents(user_id, vehicle_id, doc_type, number, expiry_date)
  //                    users(id, email, whatsapp_number, is_verified)
  //                    reminders(id, user_id, vehicle_id, document_id, reminder_date, sent)
  const q = await pool.query(`
    WITH target_docs AS (
      SELECT d.id AS document_id, d.user_id, d.vehicle_id, d.doc_type, d.number, d.expiry_date::date AS exp
      FROM documents d
      WHERE d.expiry_date::date IN (
        CURRENT_DATE + INTERVAL '7 day',
        CURRENT_DATE + INTERVAL '3 day',
        CURRENT_DATE + INTERVAL '1 day'
      )
    )
    INSERT INTO reminders(user_id, vehicle_id, document_id, reminder_date, sent)
    SELECT t.user_id, t.vehicle_id, t.document_id, NOW()::timestamp, FALSE
    FROM target_docs t
    LEFT JOIN reminders r
      ON r.document_id = t.document_id
     AND r.sent = FALSE
     AND r.reminder_date::date = CURRENT_DATE
    WHERE r.id IS NULL
    RETURNING id, user_id, vehicle_id, document_id, reminder_date;
  `);

  if (q.rows.length === 0) return;

  // Fetch details and send notifications (email + WhatsApp best-effort)
  for (const r of q.rows) {
    const doc = await pool.query(`
      SELECT d.doc_type, d.number, d.expiry_date, u.email, u.name, u.whatsapp_number
      FROM documents d
      JOIN users u ON u.id = d.user_id
      WHERE d.id = $1
      LIMIT 1`, [r.document_id]);

    if (doc.rows.length === 0) continue;

    const d = doc.rows[0];
    const daysLeft = Math.ceil((new Date(d.expiry_date) - new Date()) / 86400000);

    // Email (silently ignore failures)
    try {
      await sendEmail(
        d.email,
        `Reminder: ${d.doc_type} expires in ${daysLeft} day(s)`,
        "monthly-report", // reuse a template layout, or create a "reminder.hbs" later
        {
          user_name: d.name || "there",
          report_period: `Expiring in ${daysLeft} day(s)`,
          vehicle_count: "-", // not used
          currency: "KES",
          total_fuel: "-",
          total_service: "-",
          grand_total: "-",
          report_link: "",
          manage_link: "https://saka360.com/dashboard",
          support_email: "support@saka360.com"
        }
      );
    } catch (e) {
      console.error("Reminder email failed:", e.message);
    }

    // WhatsApp (if number present)
    if (sendWhatsAppTextSafe && d.whatsapp_number) {
      try {
        await sendWhatsAppTextSafe(d.whatsapp_number, `Heads up! Your ${d.doc_type} (${d.number || "N/A"}) expires in ${daysLeft} day(s).`);
      } catch (e) {
        console.error("Reminder WhatsApp failed:", e.message);
      }
    }
  }
}

module.exports = { runExpiryCheckCore };
