// routes/reminders.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool');                   // DB pool provided by index.js
  const runExpiryCheck = app.get('runExpiryCheck'); // wired in index.js (utils/reminders)

  // -----------------------------
  // GET /api/reminders/pending
  // -----------------------------
  router.get('/pending', authenticateToken, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT 
            r.id AS reminder_id, 
            r.reminder_date, 
            r.vehicle_id,
            v.name AS vehicle_name, 
            v.plate_number,
            d.id AS document_id, 
            d.doc_type, 
            d.number AS doc_number, 
            d.expiry_date
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
        days_left: Math.ceil(
          (new Date(r.expiry_date) - today) / (1000 * 60 * 60 * 24)
        ),
      }));

      res.json({ reminders });
    } catch (err) {
      console.error('Reminders /pending error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // -----------------------------
  // POST /api/reminders/mark-sent
  // -----------------------------
  router.post('/mark-sent', authenticateToken, async (req, res) => {
    try {
      const { reminder_id } = req.body;
      if (!reminder_id) {
        return res.status(400).json({ error: 'Reminder ID is required' });
      }

      const result = await pool.query(
        `UPDATE reminders
           SET sent = true
         WHERE id = $1 AND user_id = $2
         RETURNING id, document_id, vehicle_id, sent, reminder_date`,
        [reminder_id, req.user.id]
      );

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: 'Reminder not found or not owned by user' });
      }

      res.json({
        message: 'Reminder marked as sent ✅',
        reminder: result.rows[0],
      });
    } catch (err) {
      console.error('Reminders /mark-sent error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // -----------------------------
  // POST /api/reminders/run-check (manual trigger)
  // -----------------------------
  router.post('/run-check', authenticateToken, async (_req, res) => {
    try {
      if (typeof runExpiryCheck !== 'function') {
        return res
          .status(500)
          .json({ error: 'runExpiryCheck function not initialized' });
      }
      await runExpiryCheck();
      res.json({ message: 'Expiry check executed manually ✅' });
    } catch (err) {
      console.error('Reminders /run-check error:', err);
      res.status(500).json({ error: 'Manual expiry check failed' });
    }
  });

  // -----------------------------
  // GET /api/reminders/settings
  // -----------------------------
  router.get('/settings', authenticateToken, async (req, res) => {
    try {
      // Ensure a settings row exists (idempotent upsert)
      await pool.query(
        `INSERT INTO user_reminder_settings (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [req.user.id]
      );

      const q = await pool.query(
        `SELECT user_id,
                channel_email,
                channel_whatsapp,
                days_before,
                quiet_hours_start,
                quiet_hours_end,
                updated_at
           FROM user_reminder_settings
          WHERE user_id = $1`,
        [req.user.id]
      );

      res.json({ settings: q.rows[0] });
    } catch (err) {
      console.error('Reminders /settings GET error:', err);
      res.status(500).json({ error: 'Failed to load settings' });
    }
  });

  // -----------------------------
  // PUT /api/reminders/settings
  // Body: { channel_email?, channel_whatsapp?, days_before?, quiet_hours_start?, quiet_hours_end? }
  // -----------------------------
  router.put('/settings', authenticateToken, async (req, res) => {
    try {
      const {
        channel_email,
        channel_whatsapp,
        days_before,
        quiet_hours_start,
        quiet_hours_end,
      } = req.body || {};

      const q = await pool.query(
        `INSERT INTO user_reminder_settings
            (user_id, channel_email, channel_whatsapp, days_before, quiet_hours_start, quiet_hours_end, updated_at)
         VALUES ($1, COALESCE($2, true), COALESCE($3, false), COALESCE($4, 14), $5, $6, NOW())
         ON CONFLICT (user_id) DO UPDATE
            SET channel_email      = COALESCE($2, user_reminder_settings.channel_email),
                channel_whatsapp   = COALESCE($3, user_reminder_settings.channel_whatsapp),
                days_before        = COALESCE($4, user_reminder_settings.days_before),
                quiet_hours_start  = $5,
                quiet_hours_end    = $6,
                updated_at         = NOW()
         RETURNING user_id, channel_email, channel_whatsapp, days_before, quiet_hours_start, quiet_hours_end, updated_at`,
        [
          req.user.id,
          typeof channel_email === 'boolean' ? channel_email : null,
          typeof channel_whatsapp === 'boolean' ? channel_whatsapp : null,
          Number.isFinite(Number(days_before)) ? Number(days_before) : null,
          Number.isFinite(Number(quiet_hours_start))
            ? Number(quiet_hours_start)
            : null,
          Number.isFinite(Number(quiet_hours_end))
            ? Number(quiet_hours_end)
            : null,
        ]
      );

      res.json({ settings: q.rows[0], message: 'Settings saved ✅' });
    } catch (err) {
      console.error('Reminders /settings PUT error:', err);
      res.status(500).json({ error: 'Failed to save settings' });
    }
  });

  // mount under /api/reminders
  app.use('/api/reminders', router);
};
