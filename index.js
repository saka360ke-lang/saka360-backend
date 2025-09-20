const PDFDocument = require('pdfkit');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken'); 
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const app = express();
const PDFDocument = require('pdfkit');
const fs = require('fs'); // not needed on Render, but useful locally

const twilio = require('twilio');

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
// Function: Check for expiring documents and create reminders + send emails
async function runExpiryCheck() {
  console.log("⏰ Running expiry check now...");
  try {
    const result = await pool.query(`
      SELECT d.id, d.doc_type, d.number, d.expiry_date, u.email, u.whatsapp_number, u.id as user_id
      FROM documents d
      JOIN users u ON d.user_id = u.id
      WHERE d.expiry_date <= NOW() + INTERVAL '14 days'
    `);

    for (let row of result.rows) {
      // Insert reminder if not already existing
      const insert = await pool.query(
        `INSERT INTO reminders (user_id, document_id, reminder_date)
         SELECT $1, $2, NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM reminders 
           WHERE document_id = $2 AND sent = false
         )
         RETURNING id`,
        [row.user_id, row.id]
      );

      // If new reminder was created → send email
      if (insert.rows.length > 0) {
        const subject = `Reminder: ${row.doc_type} expiring soon`;
        const text = `Hello,

Your ${row.doc_type} (No: ${row.number || "N/A"}) will expire on ${new Date(row.expiry_date).toDateString()}.

Please renew it to remain compliant.

– Saka360`;

        await sendEmail(row.email, subject, text);
        console.log(`📧 Reminder email sent to ${row.email} for ${row.doc_type}`);
      }
    }
  } catch (err) {
    console.error("Expiry check error:", err);
  }
}

function fmtDate(d) {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Function: Check for expiring documents and create reminders + send emails & WhatsApp
async function runExpiryCheck() {
  console.log("⏰ Running expiry check now...");
  try {
    const result = await pool.query(`
      SELECT d.id, d.vehicle_id, d.doc_type, d.number, d.expiry_date,
             u.email, u.whatsapp_number, u.id as user_id
      FROM documents d
      JOIN users u ON d.user_id = u.id
      WHERE d.expiry_date <= NOW() + INTERVAL '14 days'
    `);

    for (let row of result.rows) {
      const insert = await pool.query(
        `INSERT INTO reminders (user_id, document_id, vehicle_id, reminder_date)
         SELECT $1, $2, $3, NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM reminders 
           WHERE document_id = $2 AND sent = false
         )
         RETURNING id`,
        [row.user_id, row.id, row.vehicle_id]
      );

      if (insert.rows.length > 0) {
        // Email
        const subject = `Reminder: ${row.doc_type} expiring soon`;
        const text = `Hello,

Your ${row.doc_type} (No: ${row.number || "N/A"}) will expire on ${fmtDate(row.expiry_date)}.

Please renew it to remain compliant.

– Saka360`;
        await sendEmail(row.email, subject, text);
        console.log(`📧 Email reminder sent to ${row.email}`);

        // WhatsApp (only if sandbox joined & number is E.164)
        if (row.whatsapp_number) {
          const waBody = `Saka360: Your ${row.doc_type} (${row.number || "N/A"}) expires on ${fmtDate(row.expiry_date)}. Please renew in time to avoid penalties.`;
          try {
            await sendWhatsAppText(row.whatsapp_number, waBody);
            console.log(`📲 WhatsApp reminder sent to ${row.whatsapp_number}`);
          } catch (e) {
            console.error("WhatsApp send failed:", e.message);
          }
        }
      }
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

// Get Fuel Report per Vehicle
app.get('/api/fuel/report/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id } = req.params;

    // Ensure vehicle belongs to the user
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

    // Totals
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
      totals: {
        total_spent,
        total_liters,
        avg_price_per_liter,
        cost_per_km,
        distance
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Service Report per Vehicle
app.get('/api/service/report/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id } = req.params;

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
      totals: {
        total_spent,
        avg_cost,
        count: service_logs.length
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Combined Vehicle Report
app.get('/api/vehicles/report/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id } = req.params;

    const check = await pool.query(
      `SELECT id, name FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Vehicle not found or not owned by user' });
    }

    // Query fuel + service in parallel
    const [fuel, service] = await Promise.all([
      pool.query(`SELECT amount, liters, price_per_liter, odometer, created_at 
                  FROM fuel_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at ASC`, 
                  [req.user.id, vehicle_id]),
      pool.query(`SELECT description, cost, odometer, created_at 
                  FROM service_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at ASC`, 
                  [req.user.id, vehicle_id])
    ]);

    const fuel_logs = fuel.rows;
    const service_logs = service.rows;

    // Totals
    const total_fuel = fuel_logs.reduce((s, r) => s + Number(r.amount), 0);
    const total_service = service_logs.reduce((s, r) => s + Number(r.cost), 0);

    res.json({
      vehicle_id,
      fuel_logs,
      service_logs,
      totals: {
        total_fuel,
        total_service,
        grand_total: total_fuel + total_service
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fleet Report (All Vehicles for Current User)
// Fleet Report (All Vehicles for Current User with Date Filtering)
app.get('/api/fleet/report', authenticateToken, async (req, res) => {
  try {
    // Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD
    const { from, to } = req.query;

    // Build date filter condition
    let dateFilter = "";
    let params = [req.user.id];

    if (from && to) {
      dateFilter = "AND created_at BETWEEN $2 AND $3";
      params.push(from, to);
    } else if (from) {
      dateFilter = "AND created_at >= $2";
      params.push(from);
    } else if (to) {
      dateFilter = "AND created_at <= $2";
      params.push(to);
    }

    // Fetch all user’s vehicles
    const vehicles = await pool.query(
      `SELECT id, name, type, plate_number
       FROM vehicles
       WHERE user_id = $1`,
      [req.user.id]
    );

    if (vehicles.rows.length === 0) {
      return res.json({ vehicles: [], fleet_totals: null });
    }

    const reports = [];

    // Loop through vehicles
    for (let v of vehicles.rows) {
      const fuel = await pool.query(
        `SELECT amount, liters, price_per_liter, odometer, created_at
         FROM fuel_logs 
         WHERE user_id=$1 AND vehicle_id=$2 ${dateFilter}
         ORDER BY created_at ASC`,
         [req.user.id, v.id, ...(params.slice(1))]
      );

      const service = await pool.query(
        `SELECT description, cost, odometer, created_at
         FROM service_logs 
         WHERE user_id=$1 AND vehicle_id=$2 ${dateFilter}
         ORDER BY created_at ASC`,
         [req.user.id, v.id, ...(params.slice(1))]
      );

      const fuel_logs = fuel.rows;
      const service_logs = service.rows;

      // Totals per vehicle
      const total_fuel = fuel_logs.reduce((s, r) => s + Number(r.amount), 0);
      const total_liters = fuel_logs.reduce((s, r) => s + Number(r.liters), 0);
      const avg_price_per_liter = total_liters > 0 ? total_fuel / total_liters : null;
      const total_service = service_logs.reduce((s, r) => s + Number(r.cost), 0);

      reports.push({
        vehicle_id: v.id,
        name: v.name,
        type: v.type,
        plate_number: v.plate_number,
        totals: {
          total_fuel,
          total_service,
          grand_total: total_fuel + total_service,
          avg_price_per_liter,
        }
      });
    }

    // Fleet-wide totals
    const fleet_totals = {
      total_fuel: reports.reduce((s, r) => s + r.totals.total_fuel, 0),
      total_service: reports.reduce((s, r) => s + r.totals.total_service, 0),
      grand_total: reports.reduce((s, r) => s + r.totals.grand_total, 0)
    };

    res.json({ vehicles: reports, fleet_totals });
  } catch (err) {
    console.error("Fleet report error:", err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fleet Report PDF (Protected)
app.get('/api/fleet/report/pdf', authenticateToken, async (req, res) => {
  try {
    const { from, to } = req.query;

    // Reuse logic from JSON report
    const vehicles = await pool.query(
      `SELECT id, name, type, plate_number
       FROM vehicles
       WHERE user_id = $1`,
      [req.user.id]
    );

    if (vehicles.rows.length === 0) {
      return res.status(404).json({ error: "No vehicles found" });
    }

    let reports = [];
    for (let v of vehicles.rows) {
      const fuel = await pool.query(
        `SELECT amount, liters, price_per_liter, odometer, created_at
         FROM fuel_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at ASC`,
         [req.user.id, v.id]
      );

      const service = await pool.query(
        `SELECT description, cost, odometer, created_at
         FROM service_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at ASC`,
         [req.user.id, v.id]
      );

      const total_fuel = fuel.rows.reduce((s, r) => s + Number(r.amount), 0);
      const total_liters = fuel.rows.reduce((s, r) => s + Number(r.liters), 0);
      const avg_price_per_liter = total_liters > 0 ? total_fuel / total_liters : null;
      const total_service = service.rows.reduce((s, r) => s + Number(r.cost), 0);

      reports.push({
        name: v.name,
        plate: v.plate_number,
        totals: {
          total_fuel,
          total_service,
          grand_total: total_fuel + total_service,
          avg_price_per_liter
        }
      });
    }

    const fleet_totals = {
      total_fuel: reports.reduce((s, r) => s + r.totals.total_fuel, 0),
      total_service: reports.reduce((s, r) => s + r.totals.total_service, 0),
      grand_total: reports.reduce((s, r) => s + r.totals.grand_total, 0)
    };

    // ---- Generate PDF ----
    const doc = new PDFDocument();
    let filename = `fleet_report_${Date.now()}.pdf`;
    res.setHeader('Content-disposition', `attachment; filename=${filename}`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    // Title
    doc.fontSize(18).text("Fleet Report", { align: 'center' });
    doc.moveDown();

    // Date range
    if (from || to) {
      doc.fontSize(12).text(`Report Range: ${from || "beginning"} to ${to || "today"}`);
    }
    doc.moveDown();

    // Vehicle breakdown
    reports.forEach((r, i) => {
      doc.fontSize(14).text(`Vehicle ${i+1}: ${r.name} (${r.plate})`);
      doc.fontSize(12).list([
        `Total Fuel: KES ${r.totals.total_fuel.toFixed(2)}`,
        `Total Service: KES ${r.totals.total_service.toFixed(2)}`,
        `Grand Total: KES ${r.totals.grand_total.toFixed(2)}`,
        `Avg Price/Liter: ${r.totals.avg_price_per_liter ? r.totals.avg_price_per_liter.toFixed(2) : "N/A"}`
      ]);
      doc.moveDown();
    });

    // Fleet totals
    doc.fontSize(16).text("Fleet Totals", { underline: true });
    doc.fontSize(12).list([
      `Total Fuel: KES ${fleet_totals.total_fuel.toFixed(2)}`,
      `Total Service: KES ${fleet_totals.total_service.toFixed(2)}`,
      `Grand Total: KES ${fleet_totals.grand_total.toFixed(2)}`
    ]);

    doc.end();

  } catch (err) {
    console.error("Fleet report PDF error:", err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});


// Setup SMTP transport (Hostinger)
const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465,
  secure: true, // use SSL
  auth: {
    user: "no-reply@saka360.com",
    pass: "Nugget119." // ⚠️ move this to .env later
  }
});

// Send email helper
async function sendEmail(to, subject, text, html = null) {
  try {
    const info = await transporter.sendMail({
      from: '"Saka360" <no-reply@saka360.com>',
      to,
      subject,
      text,
      html: html || text,
    });
    console.log("📧 Email sent:", info.messageId);
    return true;
  } catch (err) {
    console.error("❌ Email error:", err);
    return false;
  }
}

// ----------------------
// WhatsApp (Twilio)
// ----------------------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+1415...'

function toWhatsAppAddr(num) {
  // Expect num in E.164, e.g. +2547XXXXXXXX
  return num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
}

async function sendWhatsAppText(toNumberE164, body) {
  if (!toNumberE164 || !body) throw new Error("to and body required");
  const msg = await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: toWhatsAppAddr(toNumberE164),
    body
  });
  console.log("📲 WhatsApp sent:", msg.sid, msg.status);
  return msg;
}

// Simple test route
app.post('/api/test-whatsapp', authenticateToken, async (req, res) => {
  try {
    const { to, body } = req.body;
    if (!to) return res.status(400).json({ error: "Recipient 'to' (E.164) required" });

    const msg = await sendWhatsAppText(to, body || "Hello from Saka360 👋 This is a WhatsApp test.");
    res.json({ message: "WhatsApp sent ✅", sid: msg.sid, status: msg.status });
  } catch (err) {
    console.error("WA test error:", err);
    res.status(500).json({ error: "Failed to send WhatsApp", detail: err.message });
  }
});


// Test email route
app.post('/api/test-email', authenticateToken, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: "Recipient email required" });

  const sent = await sendEmail(
    to,
    "Saka360 Test Email",
    "Hello! 👋 This is a test email from your Saka360 backend."
  );

  if (sent) {
    res.json({ message: "Test email sent ✅" });
  } else {
    res.status(500).json({ error: "Failed to send email" });
  }
});

// Generate Vehicle Report as PDF (Protected)
app.get('/api/reports/vehicle/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const vehicleId = req.params.id;

    // 1. Fetch Vehicle Info
    const vResult = await pool.query(
      `SELECT * FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicleId, req.user.id]
    );
    if (vResult.rows.length === 0) {
      return res.status(404).json({ error: "Vehicle not found" });
    }
    const vehicle = vResult.rows[0];

    // 2. Fetch Fuel Logs
    const fuelResult = await pool.query(
      `SELECT * FROM fuel_logs WHERE vehicle_id = $1 ORDER BY created_at`,
      [vehicleId]
    );

    // 3. Fetch Service Logs
    const serviceResult = await pool.query(
      `SELECT * FROM service_logs WHERE vehicle_id = $1 ORDER BY created_at`,
      [vehicleId]
    );

    // 4. Fetch Documents
    const docsResult = await pool.query(
      `SELECT * FROM documents WHERE vehicle_id = $1 ORDER BY expiry_date`,
      [vehicleId]
    );

    // ---------------- PDF GENERATION ----------------
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=vehicle_${vehicleId}_report.pdf`);

    const doc = new PDFDocument();
    doc.pipe(res); // stream directly to response

    // Header
    doc.fontSize(18).text(`Saka360 Vehicle Report`, { align: "center" });
    doc.moveDown();
    doc.fontSize(14).text(`Vehicle: ${vehicle.make || ''} ${vehicle.model || ''} (${vehicle.registration_no || ''})`);
    doc.text(`Owner: ${req.user.name} | Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();

    // Fuel Logs
    doc.fontSize(16).text("⛽ Fuel Logs", { underline: true });
    if (fuelResult.rows.length === 0) {
      doc.text("No fuel logs available");
    } else {
      fuelResult.rows.forEach(log => {
        doc.text(
          `Date: ${new Date(log.created_at).toLocaleDateString()} | Amount: ${log.amount} | Liters: ${log.liters.toFixed(2)} | Odo: ${log.odometer}`
        );
      });
    }
    doc.moveDown();

    // Service Logs
    doc.fontSize(16).text("🔧 Service Logs", { underline: true });
    if (serviceResult.rows.length === 0) {
      doc.text("No service logs available");
    } else {
      serviceResult.rows.forEach(log => {
        doc.text(
          `Date: ${new Date(log.created_at).toLocaleDateString()} | ${log.description} | Cost: ${log.cost} | Odo: ${log.odometer}`
        );
      });
    }
    doc.moveDown();

    // Documents
    doc.fontSize(16).text("📄 Documents", { underline: true });
    if (docsResult.rows.length === 0) {
      doc.text("No documents available");
    } else {
      docsResult.rows.forEach(docRow => {
        doc.text(
          `${docRow.doc_type} (${docRow.number || "N/A"}) → Expires: ${new Date(docRow.expiry_date).toLocaleDateString()}`
        );
      });
    }

    doc.end();
  } catch (err) {
    console.error("PDF error:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
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
