// routes/documents.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool'); // Use the database pool set in index.js

  // ===========================
  // 1️⃣ Add New Document
  // ===========================
  router.post('/add', authenticateToken, async (req, res) => {
    try {
      let { vehicle_id, doc_type, number, expiry_date } = req.body;

      // Basic validation
      if (!vehicle_id || !doc_type || !expiry_date) {
        return res.status(400).json({
          error: 'Vehicle ID, document type, and expiry date are required'
        });
      }

      vehicle_id = parseInt(vehicle_id, 10);
      if (Number.isNaN(vehicle_id)) {
        return res.status(400).json({ error: 'vehicle_id must be a number' });
      }

      const expiry = new Date(expiry_date);
      if (isNaN(expiry.getTime())) {
        return res.status(400).json({
          error: 'expiry_date must be a valid date (e.g. 2025-12-31)'
        });
      }

      // Verify vehicle belongs to the logged-in user
      const vcheck = await pool.query(
        `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
        [vehicle_id, req.user.id]
      );
      if (vcheck.rows.length === 0) {
        return res
          .status(403)
          .json({ error: 'Vehicle not found or not owned by user' });
      }

      // Insert document record
      const result = await pool.query(
        `INSERT INTO documents (user_id, vehicle_id, doc_type, number, expiry_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, vehicle_id, doc_type, number, expiry_date, created_at`,
        [req.user.id, vehicle_id, doc_type, number || null, expiry_date]
      );

      res.status(201).json({ document: result.rows[0] });
    } catch (err) {
      console.error('Documents /add error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ===========================
  // 2️⃣ Get All Documents for a Vehicle
  // ===========================
  router.get('/history/:vehicle_id', authenticateToken, async (req, res) => {
    try {
      const vehicle_id = parseInt(req.params.vehicle_id, 10);
      if (Number.isNaN(vehicle_id)) {
        return res.status(400).json({ error: 'vehicle_id must be a number' });
      }

      // Verify vehicle belongs to the logged-in user
      const vcheck = await pool.query(
        `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
        [vehicle_id, req.user.id]
      );
      if (vcheck.rows.length === 0) {
        return res
          .status(403)
          .json({ error: 'Vehicle not found or not owned by user' });
      }

      // Fetch documents
      const result = await pool.query(
        `SELECT id, vehicle_id, doc_type, number, expiry_date, created_at
         FROM documents
         WHERE user_id = $1 AND vehicle_id = $2
         ORDER BY expiry_date ASC`,
        [req.user.id, vehicle_id]
      );

      // Add “days_left” field for each document
      const today = new Date();
      const documents = result.rows.map((doc) => {
        const expiry = new Date(doc.expiry_date);
        const diffDays = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
        return { ...doc, days_left: diffDays };
      });

      res.json({ documents });
    } catch (err) {
      console.error('Documents /history error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Mount this router under /api/docs
  app.use('/api/docs', router);
};
