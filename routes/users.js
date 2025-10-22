// routes/users.js
const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { authenticateToken } = require("../middleware/auth");
const { sendEmail } = require("../utils/mailer");

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool"); // shared pg pool from index.js

  // ============= REGISTER =============
  // POST /api/users/register
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

      // Fire-and-forget (won’t block success if SMTP down)
      sendEmail(user.email, "Verify your Saka360 account", "verification", {
        user_name: user.name || "there",
        verification_link: verificationLink,
      }).catch((e) => console.error("sendEmail(verification) warning:", e.message));

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

  // ================ LOGIN ================
  // POST /api/users/login
  router.post("/login", async (req, res) => {
    try {
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

  // ================= ME =================
  // GET /api/users/me  (JWT required)
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

  // ======== FORGOT PASSWORD (send email) ========
  // POST /api/users/forgot-password   { "email": "user@example.com" }
  router.post("/forgot-password", async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ error: "Email is required" });

      const uq = await pool.query(
        `SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
      );

      // Always return OK (avoid user enumeration)
      if (uq.rows.length === 0) {
        return res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
      }

      const user = uq.rows[0];
      const token = crypto.randomBytes(32).toString("hex");
      const expiresMinutes = 60;
      const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);

      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, token, expiresAt]
      );

      const base = process.env.APP_BASE_URL || "https://saka360.com";
      const resetLink = `${base}/reset-password?token=${encodeURIComponent(token)}`;

      // Email the link (template: templates/reset-password.hbs)
      sendEmail(user.email, "Reset your Saka360 password", "reset-password", {
        user_name: user.name || "there",
        reset_link: resetLink,
        expires_minutes: String(expiresMinutes),
      }).catch((e) => console.error("sendEmail(reset-password) warning:", e.message));

      return res.json({ ok: true, message: "If that email exists, a reset link has been sent." });
    } catch (err) {
      console.error("users.forgot-password error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ======== RESET PASSWORD (submit token + new pass) ========
  // POST /api/users/reset-password   { "token":"...", "new_password":"..." }
  router.post("/reset-password", async (req, res) => {
    try {
      const { token, new_password } = req.body || {};
      if (!token || !new_password) {
        return res.status(400).json({ error: "token and new_password are required" });
      }
      if (new_password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const tq = await pool.query(
        `SELECT prt.id, prt.user_id, prt.expires_at, prt.used_at
           FROM password_reset_tokens prt
          WHERE prt.token = $1
          LIMIT 1`,
        [token]
      );

      if (tq.rows.length === 0) {
        return res.status(400).json({ error: "Invalid or expired token" });
      }

      const t = tq.rows[0];
      if (t.used_at) {
        return res.status(400).json({ error: "This token has already been used" });
      }
      if (new Date(t.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ error: "This token has expired" });
      }

      const hash = await bcrypt.hash(new_password, 10);

      await pool.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [hash, t.user_id]
      );

      await pool.query(
        `UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`,
        [t.id]
      );

      return res.json({ ok: true, message: "Password has been reset successfully ✅" });
    } catch (err) {
      console.error("users.reset-password error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ---------- VERIFY EMAIL ----------
router.get("/verify", async (req, res) => {
  try {
    const token = (req.query?.token || "").trim(); // format we used: `${user.id}-${Date.now()}`
    if (!token || !token.includes("-")) {
      return res.status(400).json({ error: "Invalid token" });
    }
    const userId = token.split("-")[0];

    const q = await pool.query(
      `UPDATE users SET is_verified = TRUE, updated_at = NOW()
         WHERE id = $1
         RETURNING id, email, is_verified`,
      [userId]
    );

    if (q.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ message: "Email verified ✅", user: q.rows[0] });
  } catch (err) {
    console.error("users.verify error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


  // MOUNT under /api/users
  app.use("/api/users", router);
};
