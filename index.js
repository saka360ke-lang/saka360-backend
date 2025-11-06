// index.js
require("dotenv").config();

const express = require("express");
const app = express();

app.set("trust proxy", 1);

// JSON for most routes
app.use(express.json());
// urlencoded (Twilio)
app.use(express.urlencoded({ extended: false }));

// Bad JSON → JSON error
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  next(err);
});

const morgan = require("morgan");
app.use(morgan("tiny"));

app.get("/api/health", (_req, res) => res.status(200).json({ status: "OK" }));

const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

app.use(helmet());

const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.set("pool", pool);

app.get("/api/health/db", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ db: "connected", time: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ db: "error", error: e.message });
  }
});

app.get("/api/diag/pool", (req, res) => {
  res.json({ pool_attached: !!app.get("pool") });
});

const { verifySmtp, sendEmail } = require("./utils/mailer");
const { runExpiryCheckCore } = require("./utils/reminders");

const twilio = require("twilio");
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM;
function getTwilioClient() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio not configured");
  }
  return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}
function toWhatsAppAddr(numE164) {
  return numE164.startsWith("whatsapp:") ? numE164 : `whatsapp:${numE164}`;
}
async function sendWhatsAppText(toE164, body) {
  if (!toE164) throw new Error("Missing 'to'");
  if (!TWILIO_FROM) throw new Error("Missing TWILIO_WHATSAPP_FROM");
  const client = getTwilioClient();
  return client.messages.create({
    from: toWhatsAppAddr(TWILIO_FROM),
    to: toWhatsAppAddr(toE164),
    body,
  });
}
function sendWhatsAppTextSafe(to, body) {
  return sendWhatsAppText(to, body).catch(err => console.error("sendWhatsAppTextSafe error:", err.message));
}

const { authenticateToken, adminOnly } = require("./middleware/auth");

app.get("/api/email-verify", authenticateToken, adminOnly, async (_req, res) => {
  try {
    const ok = await verifySmtp();
    res.json({ ok, message: "SMTP connection OK ✅" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "SMTP verification failed", detail: err.message });
  }
});

app.post("/api/test-whatsapp", authenticateToken, adminOnly, async (req, res) => {
  try {
    const { to, body } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to' (E.164 like +2547XXXXXXX)" });
    const msg = await sendWhatsAppText(to, body || "Saka360 WhatsApp test ✅");
    res.json({ message: "WhatsApp sent ✅", sid: msg.sid, status: msg.status });
  } catch (err) {
    res.status(500).json({ error: "Failed to send WhatsApp", detail: err.message });
  }
});

let cron = null;
try { cron = require("node-cron"); } catch (e) {
  console.error("[cron] node-cron not available; skipping schedules:", e.message);
}
app.set("runExpiryCheck", () => runExpiryCheckCore(pool, { sendEmail, sendWhatsAppTextSafe }));
if (cron) {
  cron.schedule(
    "0 8 * * *",
    () => runExpiryCheckCore(pool, { sendEmail, sendWhatsAppTextSafe }).catch(e => console.error("runExpiryCheckCore error:", e)),
    { timezone: "Africa/Nairobi" }
  );
}

/* ------- ROUTES ------- */
require("./routes/users")(app);
require("./routes/fuel")(app);
require("./routes/service")(app);
require("./routes/documents")(app);
require("./routes/reminders")(app);
require("./routes/reports")(app);
require("./routes/whatsapp")(app);

const chatRoutes = require("./routes/chat");
app.use("/api", chatRoutes);

const subscriptionsRoutes = require("./routes/subscriptions");
app.use("/api/subscriptions", subscriptionsRoutes);

const testEmailRoutes = require("./routes/testEmail");
app.use("/api", testEmailRoutes);

const uploadsRoutes = require("./routes/uploads");
app.use("/api/uploads", uploadsRoutes);

// NEW: Paystack payments (mounted via exported function)
require("./routes/payments")(app);

app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  const status = err.status || 500;
  res.status(status).type("application/json").send({
    error: status === 404 ? "Not found" : "Server error",
    detail: process.env.DEBUG_MODE === "1" ? (err?.message || String(err)) : undefined,
    path: req.originalUrl,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
