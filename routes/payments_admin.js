// routes/payments_admin.js
const express = require("express");
const { authenticateToken, adminOnly } = require("../middleware/auth");
const { sendEmail } = require("../utils/mailer"); // optional: for invoice emails on backfill

const router = express.Router();

function getPool(req) {
  const pool = req.app.get("pool");
  if (!pool) throw new Error("Pool not found on app; set app.set('pool', pool) in index.js");
  return pool;
}

/**
 * GET /api/payments/admin/preview
 * Shows which successful payments would be backfilled into user_subscriptions.
 */
router.get("/admin/preview", authenticateToken, adminOnly, async (req, res) => {
  try {
    const pool = getPool(req);
    const rows = (await pool.query(
      `
      SELECT p.id, p.user_id, u.email, u.name,
             p.reference, p.plan_code, p.amount_cents, p.currency, p.status, p.created_at
      FROM payments p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN user_subscriptions us
        ON us.user_id = p.user_id AND us.plan_code = p.plan_code
      WHERE p.status = 'success'
        AND p.plan_code IS NOT NULL
        AND us.user_id IS NULL
      ORDER BY p.id DESC
      LIMIT 50;
      `
    )).rows;

    res.json({ ok: true, count: rows.length, candidates: rows });
  } catch (e) {
    console.error("payments.admin.preview error:", e);
    res.status(500).json({ error: "preview failed", detail: e.message });
  }
});

/**
 * POST /api/payments/admin/backfill
 * Body: { send_emails?: boolean }
 * Backfills missing rows into user_subscriptions from successful payments with a plan_code.
 * If send_emails=true, sends subscription invoice emails for each backfilled record.
 */
router.post("/admin/backfill", authenticateToken, adminOnly, async (req, res) => {
  const sendEmails = !!req.body?.send_emails;
  const pool = getPool(req);

  try {
    // 1) Insert missing subscriptions
    const ins = await pool.query(
      `
      INSERT INTO user_subscriptions (user_id, plan_code, status, started_at, renewed_at, meta)
      SELECT p.user_id,
             p.plan_code,
             'active',
             NOW(),
             NOW(),
             jsonb_build_object('reference', p.reference, 'source', 'admin-backfill')
      FROM payments p
      LEFT JOIN user_subscriptions us
        ON us.user_id = p.user_id AND us.plan_code = p.plan_code
      WHERE p.status = 'success'
        AND p.plan_code IS NOT NULL
        AND us.user_id IS NULL
      RETURNING user_id, plan_code;
      `
    );

    // 2) Optionally send emails
    const emailed = [];
    if (sendEmails && ins.rows.length) {
      for (const row of ins.rows) {
        const u = (await pool.query(`SELECT email, name FROM users WHERE id=$1`, [row.user_id])).rows[0];
        if (!u?.email) continue;

        // Grab latest successful payment for this user/plan
        const p = (await pool.query(
          `
          SELECT reference, amount_cents, currency, created_at
          FROM payments
          WHERE user_id=$1 AND plan_code=$2 AND status='success'
          ORDER BY id DESC
          LIMIT 1
          `,
          [row.user_id, row.plan_code]
        )).rows[0];

        const plan = (await pool.query(
          `SELECT name FROM subscription_plans WHERE UPPER(code)=UPPER($1) LIMIT 1`, [row.plan_code]
        )).rows[0];

        const amount_cents = p?.amount_cents || 0;
        const currency = p?.currency || "KES";
        const plan_name = plan?.name || row.plan_code;
        const invoice_number = `INV-${p?.reference || Date.now()}`;
        const issued_at = p?.created_at?.toISOString?.() || new Date().toISOString();

        try {
          await sendEmail(
            u.email,
            "Saka360 Invoice",
            "subscription_invoice",
            {
              user_name: u.name || "there",
              plan_name,
              plan_code: row.plan_code,
              amount_cents,
              currency,
              invoice_number,
              issued_at,
              period_start: new Date().toISOString().slice(0,10), // simple placeholders
              period_end: new Date(Date.now() + 30*864e5).toISOString().slice(0,10),
              payment_link: `${process.env.APP_BASE_URL || ""}/billing`
            }
          );
          emailed.push({ user_id: row.user_id, email: u.email, plan_code: row.plan_code });
        } catch (e) {
          console.error("email send failed (backfill):", e.message);
        }
      }
    }

    res.json({
      ok: true,
      inserted: ins.rowCount,
      sent_emails: emailed.length,
      sent_email_recipients: emailed
    });
  } catch (e) {
    console.error("payments.admin.backfill error:", e);
    res.status(500).json({ error: "backfill failed", detail: e.message });
  }
});

module.exports = router;
