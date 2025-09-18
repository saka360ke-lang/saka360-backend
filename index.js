const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken'); 
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ======================
// Middleware
// ======================
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
    req.user = user;
    next();
  });
}

// ======================
// Database
// ======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ======================
// Utility Functions
// ======================
async function runExpiryCheck() {
  console.log("⏰ Running expiry check now...");
  try {
    const result = await pool.query(`
      SELECT d.id, d.vehicle_id, d.doc_type, d.number, d.expiry_date,
             u.email, u.whatsapp_number, u.id AS user_id
      FROM documents d
      JOIN users u ON d.user_id = u.id
      WHERE d.expiry_date <= NOW() + INTERVAL '14 days'
    `);

    for (let row of result.rows) {
      await pool.query(
        `INSERT INTO reminders (user_id, document_id, vehicle_id, reminder_date)
         SELECT $1, $2, $3, NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM reminders
           WHERE document_id = $2 AND sent = false
         )`,
        [row.user_id, row.id, row.vehicle_id]
      );

      console.log(`✅ Reminder prepared for ${row.doc_type} (veh ${row.vehicle_id}) expiring ${row.expiry_date} for ${row.email}`);
    }
  } catch (err) {
    console.error("Expiry check error:", err);
  }
}

// ======================
// Routes: Health
// ======================
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'OK', db: 'connected', time: result.rows[0].now });
  } catch (err) {
    res.json({ status: 'OK', db: 'error', error: err.message });
  }
});

// ======================
// Routes: Users
// ======================
app.post('/api/users/register', async (req, res) => {
  try {
    const { name, email, whatsapp_number, password } = req.body;
    if (!name || !email || !whatsapp_number || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const password_hash = await bcrypt.hash(password, 10);

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

app.post('/api/users/login', async (req, res) => {
  try {
    const { email, whatsapp_number, password } = req.body;
    if ((!email && !whatsapp_number) || !password) {
      return res.status(400).json({ error: 'Email or WhatsApp and password are required' });
    }

    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1 OR whatsapp_number = $2`,
      [email || null, whatsapp_number || null]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Invalid password' });
    }

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

// ======================
// Routes: Fuel
// ======================
// Add Fuel Log (Protected, Vehicle-specific)
app.post('/api/fuel/add', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id, amount, price_per_liter, odometer } = req.body;

    if (!vehicle_id || !amount || !price_per_liter || !odometer) {
      return res.status(400).json({ error: 'Vehicle ID, amount, price per liter, and odometer are required' });
    }

    // Check vehicle belongs to user
    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );

    if (vcheck.rows.length === 0) {
      return res.status(403).json({ error: 'Vehicle not found or not owned by this user' });
    }

    // Calculate liters
    const liters = amount / price_per_liter;

    // Insert into DB
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

// Get Fuel History with Totals (Protected, per vehicle)
app.get('/api/fuel/history/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const vehicle_id = req.params.vehicle_id;

    // Verify ownership
    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );

    if (vcheck.rows.length === 0) {
      return res.status(403).json({ error: 'Vehicle not found or not owned by this user' });
    }

    const result = await pool.query(
      `SELECT id, vehicle_id, amount, price_per_liter, liters, odometer, created_at
       FROM fuel_logs
       WHERE user_id = $1 AND vehicle_id = $2
       ORDER BY created_at DESC`,
      [req.user.id, vehicle_id]
    );

    const fuel_logs = result.rows;
    if (fuel_logs.length === 0) {
      return res.json({ fuel_logs: [], totals: null });
    }

    const total_spent = fuel_logs.reduce((sum, log) => sum + Number(log.amount), 0);
    const total_liters = fuel_logs.reduce((sum, log) => sum + Number(log.liters), 0);
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
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ======================
// Routes: Service
// ======================
// Add Service Log (Protected, Vehicle-specific)
app.post('/api/service/add', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id, description, cost, odometer } = req.body;

    if (!vehicle_id || !description || !cost || !odometer) {
      return res.status(400).json({ error: 'Vehicle ID, description, cost, and odometer are required' });
    }

    // Check vehicle ownership
    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );

    if (vcheck.rows.length === 0) {
      return res.status(403).json({ error: 'Vehicle not found or not owned by this user' });
    }

    const result = await pool.query(
      `INSERT INTO service_logs (user_id, vehicle_id, description, cost, odometer)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, vehicle_id, description, cost, odometer, created_at`,
      [req.user.id, vehicle_id, description, cost, odometer]
    );

    res.status(201).json({ service_log: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Service History with Totals (Protected, per vehicle)
app.get('/api/service/history/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const vehicle_id = req.params.vehicle_id;

    // Check vehicle ownership
    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );

    if (vcheck.rows.length === 0) {
      return res.status(403).json({ error: 'Vehicle not found or not owned by this user' });
    }

    const result = await pool.query(
      `SELECT id, vehicle_id, description, cost, odometer, created_at
       FROM service_logs
       WHERE user_id = $1 AND vehicle_id = $2
       ORDER BY created_at DESC`,
      [req.user.id, vehicle_id]
    );

    const service_logs = result.rows;
    if (service_logs.length === 0) {
      return res.json({ service_logs: [], totals: null });
    }

    const total_spent = service_logs.reduce((sum, log) => sum + Number(log.cost), 0);
    const avg_cost = total_spent / service_logs.length;

    res.json({
      service_logs,
      totals: { total_spent, avg_cost, count: service_logs.length }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ======================
// Routes: Documents
// ======================
// Add Document/License (Protected, Vehicle-specific)
app.post('/api/docs/add', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id, doc_type, number, expiry_date } = req.body;

    if (!vehicle_id || !doc_type || !expiry_date) {
      return res.status(400).json({ error: 'Vehicle ID, document type, and expiry date are required' });
    }

    // Check vehicle ownership
    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );

    if (vcheck.rows.length === 0) {
      return res.status(403).json({ error: 'Vehicle not found or not owned by this user' });
    }

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

// Get All Documents for a Vehicle (Protected)
app.get('/api/docs/history/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const vehicle_id = req.params.vehicle_id;

    // Check vehicle ownership
    const vcheck = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );

    if (vcheck.rows.length === 0) {
      return res.status(403).json({ error: 'Vehicle not found or not owned by this user' });
    }

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

// ======================
// Routes: Reminders
// ======================
// Mark Reminder as Sent (Protected)
app.post('/api/reminders/mark-sent', authenticateToken, async (req, res) => {
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
      return res.status(404).json({ error: 'Reminder not found or not owned by user' });
    }

    res.json({ message: 'Reminder marked as sent ✅', reminder: result.rows[0] });
  } catch (err) {
    console.error("Mark-sent error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});


app.post('/api/reminders/run-check', authenticateToken, async (req, res) => {
  try {
    await runExpiryCheck();
    res.json({ message: "Expiry check executed manually ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Manual expiry check failed' });
  }
});

// Get pending reminders (unsent), enriched with doc + vehicle details (Protected)
app.get('/api/reminders/pending', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT r.id AS reminder_id,
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
      WHERE r.user_id = $1
        AND r.sent = false
      ORDER BY d.expiry_date ASC, r.reminder_date DESC
      `,
      [req.user.id]
    );

    const today = new Date();
    const reminders = result.rows.map(row => {
      const days_left = Math.ceil((new Date(row.expiry_date) - today) / (1000 * 60 * 60 * 24));
      return { ...row, days_left };
    });

    res.json({ reminders });
  } catch (err) {
    console.error("Pending reminders error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/reminders/run-check', authenticateToken, async (req, res) => {
  try {
    const before = await pool.query(`SELECT COUNT(*)::int AS c FROM reminders WHERE user_id = $1`, [req.user.id]);
    await runExpiryCheck();
    const after = await pool.query(`SELECT COUNT(*)::int AS c FROM reminders WHERE user_id = $1`, [req.user.id]);
    res.json({ message: "Expiry check executed manually ✅", new_reminders: after.rows[0].c - before.rows[0].c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Manual expiry check failed' });
  }
});

// ======================
// Route: Vehicle
// ======================
app.post('/api/vehicles/add', authenticateToken, async (req, res) => {
  try {
    const { name, plate_number, type } = req.body;

    if (!name || !plate_number) {
      return res.status(400).json({ error: 'Name and plate number are required' });
    }

    const result = await pool.query(
      `INSERT INTO vehicles (user_id, name, plate_number, type)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, plate_number, type, created_at`,
      [req.user.id, name, plate_number, type || null]
    );

    res.status(201).json({ vehicle: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Plate number already exists' });
    } else {
      res.status(500).json({ error: 'Server error' });
    }
  }
});


// ======================
// Cron Job
// ======================
cron.schedule('0 8 * * *', runExpiryCheck);

// ======================
// Start Server
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
