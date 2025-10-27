// routes/reminders.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool');            // shared PG pool from index.js
  const runExpiryCheck = app.get('runExpiryCheck'); // optional (wired in index.js)

  // ---------- helpers ----------
  async function ensureSettings(userId) {
    // Creates a default row if one doesn’t exist
    await pool.query(
      `INSERT INTO reminder_settings (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  }

  function asBool(v) {
    if (v === true || v === false) return v;
    if (typeof v === 'string') {
      const s = v.toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
    }
    return undefined;
  }

  function asInt(v) {
    if (v === null || v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isInteger(n) ? n : undefined;
  }

  // ===========================
  // 0) Settings GET
  // GET /api/reminders/settings
  // ===========================
  router.get('/settings', authenticateToken, async (req, res) => {
    try {
      await ensureSettings(req.user.id);
      const q = await pool.query(
        `SELECT user_id, email_enabled, email_days_before,
                whatsapp_enabled, whatsapp_days_before, updated_at
           FROM reminder_settings
          WHERE user_id = $1
          LIMIT 1`,
        [req.user.id]
      );
      return res.json({ settings: q.rows[0] });
    } catch (err) {
      console.error('reminders.settings GET error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ===========================
  // 1) Settings UPDATE
  // PUT /api/reminders/settings
  // Body (all optional):
  // {
  //   "email_enabled": true|false,
  //   "email_days_before": 0..365,
  //   "whatsapp_enabled": true|false,
  //   "whatsapp_days_before": 0..365
  // }
  // ===========================
  router.put('/settings', authenticateToken, async (req, res) => {
    try {
      await ensureSettings(req.user.id);

      const email_enabled = asBool(req.body?.email_enabled);
      const whatsapp_enabled = asBool(req.body?.whatsapp_enabled);
      const email_days_before = asInt(req.body?.email_days_before);
      const whatsapp_days_before = asInt(req.body?.whatsapp_days_before);

      // Range checks for days
      const badDays =
        (email_days_before !== undefined && (email_days_before < 0 || email_days_before > 365)) ||
        (whatsapp_days_before !== undefined && (whatsapp_days_before < 0 || whatsapp_days_before > 365));
      if (badDays) {
        return res.status(400).json({ error: 'Days must be between 0 and 365' });
      }

      // Build an UPSERT with only provided fields
      const fields = [];
      const values = [req.user.id];
      const sets = [];

      if (email_enabled !== undefined) {
        fields.push('email_enabled');
        values.push(email_enabled);
        sets.push(`email_enabled = EXCLUDED.email_enabled`);
      }
      if (email_days_before !== undefined) {
        fields.push('email_days_before');
        values.push(email_days_before);
        sets.push(`email_days_before = EXCLUDED.email_days_before`);
      }
      if (whatsapp_enabled !== undefined) {
        fields.push('whatsapp_enabled');
        values.push(whatsapp_enabled);
        sets.push(`whatsapp_enabled = EXCLUDED.whatsapp_enabled`);
      }
      if (whatsapp_days_before !== undefined) {
        fields.push('whatsapp_days_before');
        values.push(whatsapp_days_before);
        sets.push(`whatsapp_days_before = EXCLUDED.whatsapp_days_before`);
      }

      // If nothing to update, just return current
      if (fields.length === 0) {
        const cur = await pool.query(
          `SELECT user_id, email_enabled, email_days_before,
                  whatsapp_enabled, whatsapp_days_before, updated_at
             FROM reminder_settings
            WHERE user_id = $1
            LIMIT 1`,
          [req.user.id]
        );
        return res.json({ settings: cur.rows[0] });
      }

      // Build parameter placeholders like $2, $3...
      const placeholders = fields.map((_, i) => `$${i + 2}`).join(', ');
      const columns = fields.join(', ');

      const sql = `
        INSERT INTO reminder_settings (user_id, ${columns})
        VALUES ($1, ${placeholders})
        ON CONFLICT (user_id) DO UPDATE SET
          ${sets.join(', ')},
          updated_at = NOW()
        RETURNING user_id, email_enabled, email_days_before,
                  whatsapp_enabled, whatsapp_days_before, updated_at
      `;

      const out = await pool.query(sql, values);
      return res.json({ settings: out.rows[0] });
    } catch (err) {
      console.error('reminders.settings PUT error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // ===========================
  // 2) Mark Reminder as Sent
  // ===========================
  router.post('/mark-sent', authenticateToken, async (req, res) => {
    try {
      const { reminder_id } = req.body;
      if (!reminder_id) {
        return res.status(400).json({ error: 'Reminder ID is required' });
      }

      const result = await pool.query(
        `UPDATE reminders
           SET sent = true, sent_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, document_id, vehicle_id, sent, sent_at, reminder_date, channel`,
        [reminder_id, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reminder not found or not owned by user' });
      }

      res.json({ message: 'Reminder marked as sent ✅', reminder: result.rows[0] });
    } catch (err) {
      console.error('Reminders /mark-sent error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ===========================
  // 3) Run Expiry Check (Manual Trigger)
  // ===========================
  router.post('/run-check', authenticateToken, async (_req, res) => {
    try {
      if (!runExpiryCheck) {
        return res.status(500).json({ error: 'runExpiryCheck function not initialized' });
      }
      await runExpiryCheck();
      res.json({ message: 'Expiry check executed manually ✅' });
    } catch (err) {
      console.error('Reminders /run-check error:', err);
      res.status(500).json({ error: 'Manual expiry check failed' });
    }
  });

  // ===========================
  // 4) Get Pending Reminders
  // ===========================
  router.get('/pending', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT r.id AS reminder_id, r.reminder_date, r.vehicle_id, r.channel, r.sent, r.sent_at,
                v.name AS vehicle_name, v.plate_number,
                d.id AS document_id, d.doc_type, d.number AS doc_number, d.expiry_date
           FROM reminders r
           JOIN documents d ON r.document_id = d.id
      LEFT JOIN vehicles v ON r.vehicle_id = v.id
          WHERE r.user_id = $1 AND r.sent = false
          ORDER BY d.expiry_date ASC, r.reminder_date DESC`,
        [req.user.id]
      );

      const today = new Date();
      const reminders = result.rows.map((r) => ({
        ...r,
        days_left: Math.ceil((new Date(r.expiry_date) - today) / (1000 * 60 * 60 * 24)),
      }));

      res.json({ reminders });
    } catch (err) {
      console.error('Reminders /pending error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Mount under /api/reminders
  app.use('/api/reminders', router);
};
