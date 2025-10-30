// routes/reminders.js
const express = require("express");
const { authenticateToken, adminOnly } = require("../middleware/auth");

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get("pool");

  // ---- SETTINGS: GET current user's settings ----
  router.get("/reminders/settings", authenticateToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT user_id, email_enabled, whatsapp_enabled, days_before, updated_at
           FROM public.user_reminder_settings
          WHERE user_id = $1
          LIMIT 1;`,
        [req.user.id]
      );

      if (r.rows.length === 0) {
        // Return defaults if none set yet
        return res.json({
          user_id: req.user.id,
          email_enabled: false,
          whatsapp_enabled: true,
          days_before: 14,
          updated_at: null
        });
      }

      res.json(r.rows[0]);
    } catch (err) {
      // If table missing, say so clearly
      const detail = err.code === "42P01"
        ? "user_reminder_settings table missing. Run the SQL migration we shared."
        : err.message;
      console.error("Reminders /settings GET error:", err);
      res.status(500).json({ error: "Failed to load settings", detail });
    }
  });

  // ---- SETTINGS: UPSERT ----
  router.put("/reminders/settings", authenticateToken, async (req, res) => {
    try {
      const { email_enabled, whatsapp_enabled, days_before } = req.body || {};

      const r = await pool.query(
        `INSERT INTO public.user_reminder_settings (user_id, email_enabled, whatsapp_enabled, days_before, updated_at)
         VALUES ($1, COALESCE($2,false), COALESCE($3,true), COALESCE($4,14), NOW())
         ON CONFLICT (user_id) DO UPDATE
           SET email_enabled    = COALESCE(EXCLUDED.email_enabled, public.user_reminder_settings.email_enabled),
               whatsapp_enabled = COALESCE(EXCLUDED.whatsapp_enabled, public.user_reminder_settings.whatsapp_enabled),
               days_before      = COALESCE(EXCLUDED.days_before, public.user_reminder_settings.days_before),
               updated_at       = NOW()
         RETURNING user_id, email_enabled, whatsapp_enabled, days_before, updated_at;`,
        [req.user.id, email_enabled, whatsapp_enabled, days_before]
      );
      res.json(r.rows[0]);
    } catch (err) {
      const detail = err.code === "42P01"
        ? "user_reminder_settings table missing. Run the SQL migration we shared."
        : err.message;
      res.status(500).json({ error: "Failed to save settings", detail });
    }
  });

  // ---- (Optional) Admin: manual run of reminder job ----
  router.post("/reminders/run-check", authenticateToken, adminOnly, async (_req, res) => {
    try {
      const runner = app.get("runExpiryCheck");
      if (!runner) return res.status(500).json({ error: "Reminder runner not configured" });
      await runner(); // already wired in index.js to runExpiryCheckCore
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to run reminder job", detail: err.message });
    }
  });

  app.use("/api", router);
};
