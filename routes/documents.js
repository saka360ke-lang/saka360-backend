const express = require('express');
const router = express.Router();

// Add Document
router.post('/add', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id, doc_type, number, expiry_date } = req.body;
    if (!vehicle_id || !doc_type || !expiry_date) {
      return res.status(400).json({ error: 'Vehicle ID, document type, and expiry date are required' });
    }

    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );
    if (vcheck.rows.length === 0) return res.status(403).json({ error: 'Vehicle not found or not owned by user' });

    const result = await pool.query(
      `INSERT INTO documents (user_id, vehicle_id, doc_type, number, expiry_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, vehicle_id, doc_type, number, expiry_date, created_at`,
      [req.user.id, vehicle_id, doc_type, number || null, expiry_date]
    );

    res.status(201).json({ document: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Document History
router.get('/history/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id } = req.params;

    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );
    if (vcheck.rows.length === 0) return res.status(403).json({ error: 'Vehicle not found or not owned by user' });

    const result = await pool.query(
      `SELECT id, vehicle_id, doc_type, number, expiry_date, created_at
       FROM documents
       WHERE user_id = $1 AND vehicle_id = $2
       ORDER BY expiry_date ASC`,
      [req.user.id, vehicle_id]
    );

    const documents = result.rows;
    const today = new Date();
    documents.forEach(doc => {
      const expiry = new Date(doc.expiry_date);
      const diffTime = expiry - today;
      doc.days_left = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    });

    res.json({ documents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = (app, pool, authenticateToken) => app.use('/api/docs', router);
