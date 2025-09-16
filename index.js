const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()'); // test DB
    res.json({ 
      status: 'OK', 
      db: 'connected', 
      time: result.rows[0].now 
    });
  } catch (err) {
    res.json({ 
      status: 'OK', 
      db: 'error', 
      error: err.message 
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
