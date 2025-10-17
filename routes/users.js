// routes/users.js
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../shared");          // assumes shared.js exports { pool }
const { sendEmail } = require("../utils/mailer");

const router = express.Router();

// POST /api/users/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password, whatsapp_number } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "name, email, password are required" });
    }

    const hashed = await bcrypt.hash(password, 10);

    // Insert and get the new user's id back
    const ins = await pool.query(
      `INSERT INTO users (name, email, password, whatsapp_number)
       VALUES ($1,$2,$3,$4)
       RETURNING id, name, email`,
      [name, email, hashed, whatsapp_number || null]
    );
    const user = ins.rows[0];

    // Build a simple verification link (replace later with a real token)
    const verificationLink = `https://saka360.com/verify?token=${user.id}-${Date.now()}`;

    // Send verification email (templates/verification.hbs)
    await sendEmail(
      user.email,
      "Verify your Saka360 account",
      "verification",
      {
        user_name: user.name || "there",
        verification_link: verificationLink
      }
    );

    res.json({ message: "Account created ✅. Verification email sent.", user_id: user.id });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Failed to register user." });
  }
});

// POST /api/users/login
router.post("/login", async (req, res) => {
  try {
    const { email, whatsapp_number, password } = req.body || {};
    if ((!email && !whatsapp_number) || !password) {
      return res.status(400).json({ error: "Email or WhatsApp and password are required" });
    }

    const result = await pool.query(
      `SELECT id, name, email, whatsapp_number, password
       FROM users
       WHERE email = $1 OR whatsapp_number = $2`,
      [email || null, whatsapp_number || null]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET || "supersecretkey",
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        whatsapp_number: user.whatsapp_number
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
