const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("../shared");

const router = express.Router();

// Registration route with verification email
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Save user to database
    const hashed = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (name, email, password) VALUES ($1, $2, $3)", [name, email, hashed]);

    // Generate verification link
    const verificationLink = `https://saka360.com/verify?token=12345`;

    // Send verification email
    await sendEmail(
      email,
      "Verify your Saka360 account",
      "verification",
      {
        user_name: name,
        verification_link: verificationLink
      }
    );

    res.json({ message: "Account created ✅. Verification email sent." });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Failed to register user." });
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
