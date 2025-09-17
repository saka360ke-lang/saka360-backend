const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken'); 

const app = express();
app.use(express.json());

// Middleware: Verify JWT Token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Expecting "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Access denied. Token required.' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'supersecretkey', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user; // store user info in request
    next();
  });
}

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'OK', db: 'connected', time: result.rows[0].now });
  } catch (err) {
    res.json({ status: 'OK', db: 'error', error: err.message });
  }
});

// User Registration API
app.post('/api/users/register', async (req, res) => {
  try {
    const { name, email, whatsapp_number, password } = req.body;

    if (!name || !email || !whatsapp_number || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Hash password before saving
    const password_hash = await bcrypt.hash(password, 10);

    // Save to DB
    const result = await pool.query(
      `INSERT INTO users (name, email, whatsapp_number, password_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, name, email, whatsapp_number, created_at`,
      [name, email, whatsapp_number, password_hash]
    );

    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Email or WhatsApp number already exists' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});

// User Login API
app.post('/api/users/login', async (req, res) => {
  try {
    const { email, whatsapp_number, password } = req.body;

    if ((!email && !whatsapp_number) || !password) {
      return res.status(400).json({ error: 'Email or WhatsApp and password are required' });
    }

    // Find user by email OR WhatsApp
    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1 OR whatsapp_number = $2`,
      [email || null, whatsapp_number || null]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Compare password
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Invalid password' });
    }

    // Generate JWT token (valid for 7 days)
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET || 'supersecretkey',
      { expiresIn: '7d' }
    );

    res.json({ 
      message: 'Login successful',
      token,
      user: { id: user.id, name: user.name, email: user.email, whatsapp_number: user.whatsapp_number }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add Fuel Log (Protected)
app.post('/api/fuel/add', authenticateToken, async (req, res) => {
  try {
    const { amount, price_per_liter, odometer } = req.body;

    if (!amount || !price_per_liter || !odometer) {
      return res.status(400).json({ error: 'Amount, price per liter, and odometer are required' });
    }

    // Calculate liters
    const liters = amount / price_per_liter;

    // Insert into DB
    const result = await pool.query(
      `INSERT INTO fuel_logs (user_id, amount, price_per_liter, liters, odometer)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, amount, price_per_liter, liters, odometer, created_at`,
      [req.user.id, amount, price_per_liter, liters, odometer]
    );

    res.status(201).json({ fuel_log: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Fuel History with Totals (Protected)
app.get('/api/fuel/history', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, amount, price_per_liter, liters, odometer, created_at
       FROM fuel_logs
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    const fuel_logs = result.rows;

    if (fuel_logs.length === 0) {
      return res.json({ fuel_logs: [], totals: null });
    }

    // Totals
    const total_spent = fuel_logs.reduce((sum, log) => sum + Number(log.amount), 0);
    const total_liters = fuel_logs.reduce((sum, log) => sum + Number(log.liters), 0);

    // Average cost per liter
    const avg_price_per_liter = total_spent / total_liters;

    // Cost per km (using difference in odometer readings)
    const first_odometer = fuel_logs[fuel_logs.length - 1].odometer; // oldest
    const last_odometer = fuel_logs[0].odometer; // latest
    const distance = last_odometer - first_odometer;
    const cost_per_km = distance > 0 ? total_spent / distance : null;

    res.json({
      fuel_logs,
      totals: {
        total_spent,
        total_liters,
        avg_price_per_liter,
        cost_per_km
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
