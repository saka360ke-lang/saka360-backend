// routes/users.js
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { authenticateToken } = require("../middleware/auth");
const { sendEmail } = require("../utils/mailer");

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool"); // shared pool from index.js

  // ---------- REGISTER ----------
  router.post("/register", async (req, res) => {
    try {
      const { name, email, whatsapp_number, password } = req.body || {};
      if (!name || !email || !password) {
        return res.status(400).json({ error: "name, email, password are required" });
      }

      const password_hash = await bcrypt.hash(password, 10);

      const result = await pool.query(
        `INSERT INTO users (name, email, whatsapp_number, password_hash, role, is_verified, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW())
         ON CONFLICT (email) DO UPDATE
           SET name = EXCLUDED.name,
               whatsapp_number = EXCLUDED.whatsapp_number,
               password_hash = EXCLUDED.password_hash,
               updated_at = NOW()
         RETURNING id, name, email, whatsapp_number, role, is_verified, created_at`,
        [name, email, whatsapp_number || null, password_hash, "user", false]
      );

      const user = result.rows[0];
      const verificationLink = `https://saka360.com/verify?token=${user.id}-${Date.now()}`;

      try {
        await sendEmail(user.email, "Verify your Saka360 account", "verification", {
          user_name: user.name || "there",
          verification_link: verificationLink,
        });
      } catch (e) {
        console.error("sendEmail(verification) warning:", e.message);
      }

      return res.json({
        message: "Account created ✅. Verification email sent (if mailer is configured).",
        user,
      });
    } catch (err) {
      console.error("users.register error:", err);
      if (err.code === "23505" && /whatsapp_number/.test(err.message || "")) {
        return res.status(400).json({ error: "WhatsApp number already exists" });
      }
      return res.status(500).json({ error: "Failed to register user." });
    }
  });

  // ---------- LOGIN ----------
  router.post("/login", async (req, res) => {
    try {
      // small hardening: trim inputs
      const email = (req.body?.email ?? "").trim();
      const whatsapp_number = (req.body?.whatsapp_number ?? "").trim();
      const password = (req.body?.password ?? "");

      if ((!email && !whatsapp_number) || !password) {
        return res.status(400).json({ error: "Email or WhatsApp and password are required" });
      }

      const q = await pool.query(
        `SELECT id, name, email, whatsapp_number, password_hash, role, is_verified
           FROM users
          WHERE ($1::text <> '' AND LOWER(email) = LOWER($1))
             OR ($2::text <> '' AND whatsapp_number = $2)
          LIMIT 1`,
        [email, whatsapp_number]
      );

      if (q.rows.length === 0) {
        return res.status(400).json({ error: "User not found" });
      }

      const user = q.rows[0];

      if (!user.password_hash) {
        return res.status(500).json({ error: "Account has no password set. Contact support." });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(400).json({ error: "Invalid password" });

      const token = jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        process.env.JWT_SECRET || "supersecretkey",
        { expiresIn: "7d" }
      );

      return res.json({
        message: "Login successful",
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          whatsapp_number: user.whatsapp_number,
          role: user.role,
          is_verified: user.is_verified,
        },
      });
    } catch (err) {
      console.error("users.login error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ---------- ME ----------
  router.get("/me", authenticateToken, async (req, res) => {
    try {
      const q = await pool.query(
        `SELECT id, name, email, whatsapp_number, role, is_verified, created_at
           FROM users
          WHERE id = $1`,
        [req.user.id]
      );
      if (q.rows.length === 0) return res.status(404).json({ error: "User not found" });
      return res.json({ user: q.rows[0] });
    } catch (err) {
      console.error("users.me error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // Mount under /api/users
  app.use("/api/users", router);
};
