// index.js
require("dotenv").config();

const express = require("express");
const app = express();

// Trust proxy (Render/Heroku) so rate-limit & IPs behave
app.set("trust proxy", 1);

// JSON body parser
app.use(express.json());

// Return JSON for malformed JSON bodies instead of HTML
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  next(err);
});

// ---------------------------
// HTTP request logger
// ---------------------------
const morgan = require("morgan");
app.use(morgan("tiny"));

/* -----------------------------
 * 0) Minimal health first (safe)
 * ----------------------------- */
app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "OK" });
});

// Security & safety middleware
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// Helmet (secure headers)
app.use(helmet());

// Lock CORS to specific origins via env ALLOWED_ORIGINS (comma-separated)
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // Allow no-origin (Postman/curl) OR if explicitly allowed
      if (!origin || ALLOWED.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Rate limiting
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* -----------------------------
 * 1) Database (shared pool)
 * ----------------------------- */
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// expose pool to function-style route modules via app.get("pool")
app.set("pool", pool);

// Optional DB health
app.get("/api/health/db", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ db: "connected", time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ db: "error", error: e.message });
  }
});

// Quick diag: confirm pool attached
app.get("/api/diag/pool", (req, res) => {
  res.json({ pool_attached: !!app.get("pool") });
});

/* ------------------------------------------------
 * 2) Infra helpers (Mailer + Twilio test endpoints)
 * ------------------------------------------------ */
const { verifySmtp, sendEmail } = require("./utils/mailer");
const { runExpiryCheckCore } = require("./utils/reminders");

// Twilio (for test WhatsApp)
const twilio = require("twilio");
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. +14155238886
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured: missing TWILIO_ACCOUNT_SID/AUTH_TOKEN");
  }
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}
function toWhatsAppAddr(numE164) {
  return numE164.startsWith("whatsapp:") ? numE164 : `whatsapp:${numE164}`;
}
async function sendWhatsAppText(toE164, body) {
  if (!toE164) throw new Error("Missing 'to' (E.164 like +2547XXXXXXXX)");
  if (!TWILIO_FROM) throw new Error("Missing TWILIO_WHATSAPP_FROM");
  const client = getTwilioClient();
  return client.messages.create({
    from: toWhatsAppAddr(TWILIO_FROM),
    to: toWhatsAppAddr(toE164),
    body,
  });
}
// Safe wrapper for cron usage (never throws out)
function sendWhatsAppTextSafe(to, body) {
  return sendWhatsAppText(to, body).catch((err) => {
    console.error("sendWhatsAppTextSafe error:", err.message);
  });
}

const { authenticateToken, adminOnly } = require("./middleware/auth");

// SMTP verify (admin-only)
app.get("/api/email-verify", authenticateToken, adminOnly, async (_req, res) => {
  try {
    const ok = await verifySmtp();
    res.json({ ok, message: "SMTP connection OK ✅" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "SMTP verification failed", detail: err.message });
  }
});

// WhatsApp test (admin-only)
app.post("/api/test-whatsapp", authenticateToken, adminOnly, async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' (E.164 like +2547XXXXXXXX)" });
    const msg = await sendWhatsAppText(to, body || "Hello 👋 This is a Saka360 WhatsApp test message ✅");
    res.json({ message: "WhatsApp sent ✅", sid: msg.sid, status: msg.status });
  } catch (err) {
    res.status(500).json({ error: "Failed to send WhatsApp", detail: err.message });
  }
});

/* -----------------------
 * 3) Cron (reminders)
 * ----------------------- */
let cron = null;
try {
  cron = require("node-cron");
} catch (e) {
  console.error("[cron] node-cron not available; skipping schedules:", e.message);
}

// Expose the real reminder runner to routes (e.g., /api/reminders/run-check)
app.set("runExpiryCheck", () =>
  runExpiryCheckCore(pool, { sendEmail, sendWhatsAppTextSafe })
);

// Only schedule if cron loaded
if (cron) {
  cron.schedule(
    "0 8 * * *",
    () =>
      runExpiryCheckCore(pool, { sendEmail, sendWhatsAppTextSafe }).catch((e) =>
        console.error("runExpiryCheckCore error:", e)
      ),
    { timezone: "Africa/Nairobi" }
  );
}

/* -------------------------------------------
 * 4) Mount your real app routes (consistent)
 * -------------------------------------------
 * Function-style routes (export a function(app)) → CALL them.
 * Router-style routes (export Router) → app.use(...)
 */

// A) function-style routes (CALL them)
require("./routes/users")(app);
require("./routes/fuel")(app);
require("./routes/service")(app);
require("./routes/documents")(app);
require("./routes/reminders")(app);
require("./routes/reports")(app);
require("./routes/whatsapp")(app); // POST /api/webhooks/whatsapp (TwiML)


// B) router-style
const chatRoutes = require("./routes/chat");     // exports Router
app.use("/api", chatRoutes);                     // POST /api/chat

const testEmailRoutes = require("./routes/testEmail");
app.use("/api", testEmailRoutes);                // /api/test-email

const uploadsRoutes = require("./routes/uploads");
app.use("/api/uploads", uploadsRoutes);

let vehiclesRoutes = null;
try {
  vehiclesRoutes = require("./routes/vehicles");
} catch (_) {}
if (vehiclesRoutes) app.use("/api/vehicles", vehiclesRoutes);

let paymentsRoutes = null;
try {
  paymentsRoutes = require("./routes/payments");
} catch (_) {}
if (paymentsRoutes) app.use("/api/payments", paymentsRoutes);

let affiliatesRoutes = null;
try {
  affiliatesRoutes = require("./routes/affiliates");
} catch (_) {}
if (affiliatesRoutes) app.use("/api/affiliates", affiliatesRoutes);

/* -----------------------
 * 5) 404 fallback
 * ----------------------- */
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// Global JSON error handler (last middleware)
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  const status = err.status || 500;
  res
    .status(status)
    .type("application/json")
    .send({
      error: status === 404 ? "Not found" : "Server error",
      detail: process.env.DEBUG_MODE === "1" ? err?.message || String(err) : undefined,
      path: req.originalUrl,
    });
});

/* -----------------------
 * 6) Start server
 * ----------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
