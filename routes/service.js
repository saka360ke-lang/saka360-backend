// routes/service.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool'); // ← use the pool created in index.js

  // Add Service Log
  router.post('/add', authenticateToken, async (req, res) => {
    try {
      let { vehicle_id, description, cost, odometer } = req.body;

      if (!vehicle_id || !description || !cost || !odometer) {
        return res.status(400).json({
          error: 'Vehicle ID, description, cost, and odometer are required'
        });
      }
      vehicle_id = parseInt(vehicle_id, 10);
      cost = parseFloat(cost);
      odometer = parseFloat(odometer);

      if (Number.isNaN(vehicle_id) || Number.isNaN(cost) || Number.isNaN(odometer)) {
        return res.status(400).json({ error: 'Numeric fields must be valid numbers' });
      }

      const vcheck = await pool.query(
        `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
        [vehicle_id, req.user.id]
      );
      if (vcheck.rows.length === 0) {
        return res.status(403).json({ error: 'Vehicle not found or not owned by user' });
      }

      const result = await pool.query(
        `INSERT INTO service_logs (user_id, vehicle_id, description, cost, odometer)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, vehicle_id, description, cost, odometer, created_at`,
        [req.user.id, vehicle_id, description, cost, odometer]
      );

      res.status(201).json({ service_log: result.rows[0] });
    } catch (err) {
      console.error('Service /add error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Get Service History
  router.get('/history/:vehicle_id', authenticateToken, async (req, res) => {
    try {
      const vehicle_id = parseInt(req.params.vehicle_id, 10);
      if (Number.isNaN(vehicle_id)) {
        return res.status(400).json({ error: 'vehicle_id must be a number' });
      }

      const vcheck = await pool.query(
        `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
        [vehicle_id, req.user.id]
      );
      if (vcheck.rows.length === 0) {
        return res.status(403).json({ error: 'Vehicle not found or not owned by user' });
      }

      const result = await pool.query(
        `SELECT id, vehicle_id, description, cost, odometer, created_at
         FROM service_logs
         WHERE user_id = $1 AND vehicle_id = $2
         ORDER BY created_at DESC`,
        [req.user.id, vehicle_id]
      );

      const service_logs = result.rows;
      if (service_logs.length === 0) return res.json({ service_logs: [], totals: null });

      const total_spent = service_logs.reduce((s, r) => s + Number(r.cost), 0);
      const avg_cost = total_spent / service_logs.length;

      res.json({
        service_logs,
        totals: { total_spent, avg_cost, count: service_logs.length }
      });
    } catch (err) {
      console.error('Service /history error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Vehicle Service Report
  router.get('/report/:vehicle_id', authenticateToken, async (req, res) => {
    try {
      const vehicle_id = parseInt(req.params.vehicle_id, 10);
      if (Number.isNaN(vehicle_id)) {
        return res.status(400).json({ error: 'vehicle_id must be a number' });
      }

      const check = await pool.query(
        `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
        [vehicle_id, req.user.id]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'Vehicle not found or not owned by user' });
      }

      const result = await pool.query(
        `SELECT id, description, cost, odometer, created_at
         FROM service_logs
         WHERE user_id = $1 AND vehicle_id = $2
         ORDER BY created_at ASC`,
        [req.user.id, vehicle_id]
      );

      const service_logs = result.rows;
      if (service_logs.length === 0) {
        return res.json({ vehicle_id, service_logs: [], totals: null });
      }

      const total_spent = service_logs.reduce((s, r) => s + Number(r.cost), 0);
      const avg_cost = total_spent / service_logs.length;

      res.json({
        vehicle_id,
        service_logs,
        totals: { total_spent, avg_cost, count: service_logs.length }
      });
    } catch (err) {
      console.error('Service /report error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Mount under /api/service
  app.use('/api/service', router);
};
