// routes/fuel.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool'); // ← use the pool created in index.js

  // Add Fuel Log
  router.post('/add', authenticateToken, async (req, res) => {
    try {
      let { vehicle_id, amount, price_per_liter, odometer } = req.body;

      // Basic validation + type casting
      if (!vehicle_id || !amount || !price_per_liter || !odometer) {
        return res.status(400).json({
          error: 'Vehicle ID, amount, price per liter, and odometer are required'
        });
      }
      vehicle_id = parseInt(vehicle_id, 10);
      amount = parseFloat(amount);
      price_per_liter = parseFloat(price_per_liter);
      odometer = parseFloat(odometer);

      if (
        Number.isNaN(vehicle_id) ||
        Number.isNaN(amount) ||
        Number.isNaN(price_per_liter) ||
        Number.isNaN(odometer)
      ) {
        return res.status(400).json({ error: 'Numeric fields must be valid numbers' });
      }

      // Verify vehicle belongs to user
      const vcheck = await pool.query(
        `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
        [vehicle_id, req.user.id]
      );
      if (vcheck.rows.length === 0) {
        return res.status(403).json({ error: 'Vehicle not found or not owned by user' });
      }

      const liters = amount / price_per_liter;

      const result = await pool.query(
        `INSERT INTO fuel_logs (user_id, vehicle_id, amount, price_per_liter, liters, odometer)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, vehicle_id, amount, price_per_liter, liters, odometer, created_at`,
        [req.user.id, vehicle_id, amount, price_per_liter, liters, odometer]
      );

      res.status(201).json({ fuel_log: result.rows[0] });
    } catch (err) {
      console.error('Fuel /add error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Get Fuel History
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
        `SELECT id, vehicle_id, amount, price_per_liter, liters, odometer, created_at
         FROM fuel_logs
         WHERE user_id = $1 AND vehicle_id = $2
         ORDER BY created_at DESC`,
        [req.user.id, vehicle_id]
      );

      const fuel_logs = result.rows;
      if (fuel_logs.length === 0) return res.json({ fuel_logs: [], totals: null });

      const total_spent = fuel_logs.reduce((s, r) => s + Number(r.amount), 0);
      const total_liters = fuel_logs.reduce((s, r) => s + Number(r.liters), 0);
      const avg_price_per_liter = total_spent / total_liters;

      const first_odometer = fuel_logs[fuel_logs.length - 1].odometer;
      const last_odometer = fuel_logs[0].odometer;
      const distance = last_odometer - first_odometer;
      const cost_per_km = distance > 0 ? total_spent / distance : null;

      res.json({
        fuel_logs,
        totals: { total_spent, total_liters, avg_price_per_liter, cost_per_km }
      });
    } catch (err) {
      console.error('Fuel /history error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Vehicle Fuel Report
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
        `SELECT id, amount, price_per_liter, liters, odometer, created_at
         FROM fuel_logs
         WHERE user_id = $1 AND vehicle_id = $2
         ORDER BY created_at ASC`,
        [req.user.id, vehicle_id]
      );

      const fuel_logs = result.rows;
      if (fuel_logs.length === 0) {
        return res.json({ vehicle_id, fuel_logs: [], totals: null });
      }

      const total_spent = fuel_logs.reduce((s, r) => s + Number(r.amount), 0);
      const total_liters = fuel_logs.reduce((s, r) => s + Number(r.liters), 0);
      const avg_price_per_liter = total_spent / total_liters;

      const first_odometer = fuel_logs[0].odometer;
      const last_odometer = fuel_logs[fuel_logs.length - 1].odometer;
      const distance = last_odometer - first_odometer;
      const cost_per_km = distance > 0 ? total_spent / distance : null;

      res.json({
        vehicle_id,
        fuel_logs,
        totals: { total_spent, total_liters, avg_price_per_liter, cost_per_km, distance }
      });
    } catch (err) {
      console.error('Fuel /report error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Mount under /api/fuel
  app.use('/api/fuel', router);
};
