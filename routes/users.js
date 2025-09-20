const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../shared");

const router = express.Router();

// Register
router.post("/register", async (req, res) => {
  try {
    const { name, email, whatsapp_number, password } = req.body;
    if (!name || !email || !whatsapp_number || !password) {
      return res.status(400).json({ error: "All fields are required" });
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
    if (err.code === "23505") {
      res.status(400).json({ error: "Email or WhatsApp number already exists" });
    } else {
      res.status(500).json({ error: "Server error" });
    }
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, whatsapp_number, password } = req.body;
    if ((!email && !whatsapp_number) || !password) {
      return res.status(400).json({ error: "Email or WhatsApp and password are required" });
    }

    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1 OR whatsapp_number = $2`,
      [email || null, whatsapp_number || null]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ error: "Invalid password" });

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET || "supersecretkey",
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      user: { id: user.id, name: user.name, email: user.email, whatsapp_number: user.whatsapp_number },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
