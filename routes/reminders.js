// routes/reminders.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool'); // Reuse the PostgreSQL pool from index.js
  const runExpiryCheck = app.get('runExpiryCheck'); // Optional (set in index.js)

  // ===========================
  // 1️⃣ Mark Reminder as Sent
  // ===========================
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
        reminder: result.rows[0]
      });
    } catch (err) {
      console.error('Reminders /mark-sent error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ===========================
  // 2️⃣ Run Expiry Check (Manual Trigger)
  // ===========================
  router.post('/run-check', authenticateToken, async (req, res) => {
    try {
      if (!runExpiryCheck) {
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

  // ===========================
  // 3️⃣ Get Pending Reminders
  // ===========================
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
        )
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
