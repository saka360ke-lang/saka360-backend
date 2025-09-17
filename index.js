const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
