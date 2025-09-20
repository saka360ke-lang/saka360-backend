const express = require('express');
const router = express.Router();

// Add Fuel Log
router.post('/add', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id, amount, price_per_liter, odometer } = req.body;
    if (!vehicle_id || !amount || !price_per_liter || !odometer) {
      return res.status(400).json({ error: 'Vehicle ID, amount, price per liter, and odometer are required' });
    }

    // Verify vehicle belongs to user
    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );
    if (vcheck.rows.length === 0) return res.status(403).json({ error: 'Vehicle not found or not owned by user' });

    const liters = amount / price_per_liter;
    const result = await pool.query(
      `INSERT INTO fuel_logs (user_id, vehicle_id, amount, price_per_liter, liters, odometer)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, vehicle_id, amount, price_per_liter, liters, odometer, created_at`,
      [req.user.id, vehicle_id, amount, price_per_liter, liters, odometer]
    );

    res.status(201).json({ fuel_log: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Fuel History
router.get('/history/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id } = req.params;

    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );
    if (vcheck.rows.length === 0) return res.status(403).json({ error: 'Vehicle not found or not owned by user' });

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

    res.json({ fuel_logs, totals: { total_spent, total_liters, avg_price_per_liter, cost_per_km } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Vehicle Fuel Report
router.get('/report/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id } = req.params;

    const check = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found or not owned by user' });

    const result = await pool.query(
      `SELECT id, amount, price_per_liter, liters, odometer, created_at
       FROM fuel_logs
       WHERE user_id = $1 AND vehicle_id = $2
       ORDER BY created_at ASC`,
      [req.user.id, vehicle_id]
    );

    const fuel_logs = result.rows;
    if (fuel_logs.length === 0) return res.json({ vehicle_id, fuel_logs: [], totals: null });

    const total_spent = fuel_logs.reduce((s, r) => s + Number(r.amount), 0);
    const total_liters = fuel_logs.reduce((s, r) => s + Number(r.liters), 0);
    const avg_price_per_liter = total_spent / total_liters;
    const first_odometer = fuel_logs[0].odometer;
    const last_odometer = fuel_logs[fuel_logs.length - 1].odometer;
    const distance = last_odometer - first_odometer;
    const cost_per_km = distance > 0 ? total_spent / distance : null;

    res.json({ vehicle_id, fuel_logs, totals: { total_spent, total_liters, avg_price_per_liter, cost_per_km, distance } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = (app, pool, authenticateToken) => app.use('/api/fuel', router);
