// index.js
require("dotenv").config();

const express = require("express");
const app = express();

// Trust proxy (Render/Heroku)
app.set("trust proxy", 1);

// ---------- Body parsers (global) ----------
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // twilio form posts

// Return JSON for malformed JSON bodies instead of HTML
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  next(err);
});

// ---------- Logging ----------
const morgan = require("morgan");
app.use(morgan("tiny"));

// ---------- Health ----------
app.get("/api/health", (_req, res) => res.status(200).json({ status: "OK" }));

// ---------- Security ----------
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

app.use(helmet());

const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // allow Postman/curl (no origin) or explicitly allowed
      if (!origin || ALLOWED.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ---------- Database ----------
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

// ---------- Infra helpers ----------
const { verifySmtp, sendEmail } = require("./utils/mailer");
const { runExpiryCheckCore } = require("./utils/reminders");

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
function sendWhatsAppTextSafe(to, body) {
  return sendWhatsAppText(to, body).catch(err =>
    console.error("sendWhatsAppTextSafe error:", err.message)
  );
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

// ---------- Cron (reminders) ----------
let cron = null;
try { cron = require("node-cron"); } catch (e) {
  console.error("[cron] node-cron not available; skipping schedules:", e.message);
}

app.set("runExpiryCheck", () =>
  runExpiryCheckCore(pool, { sendEmail, sendWhatsAppTextSafe })
);

if (cron) {
  cron.schedule(
    "0 8 * * *",
    () => runExpiryCheckCore(pool, { sendEmail, sendWhatsAppTextSafe })
            .catch(e => console.error("runExpiryCheckCore error:", e)),
    { timezone: "Africa/Nairobi" }
  );
}

// ----------------------------------------------------
// Safe mount helpers: prevent "reading 'apply' of undefined"
// ----------------------------------------------------
function safeUse(path, mod) {
  try {
    if (!mod) {
      console.warn(`[mount-skip] ${path}: module is undefined`);
      return;
    }
    // If the module exported a Router directly:
    if (typeof mod === "function" && mod.name === "router") {
      app.use(path, mod);
      console.log(`[mounted] ${path} (router)`);
      return;
    }
    // If it exported a function that returns a Router:
    if (typeof mod === "function" && !mod.name) {
      const maybe = mod();
      if (maybe && typeof maybe === "function" && maybe.name === "router") {
        app.use(path, maybe);
        console.log(`[mounted] ${path} (factory->router)`);
        return;
      }
    }
    // If it exported an object that *is* a Router:
    if (mod && typeof mod === "function") {
      app.use(path, mod);
      console.log(`[mounted] ${path} (router-like)`);
      return;
    }
    console.warn(`[mount-skip] ${path}: not a Router/function export`);
  } catch (e) {
    console.error(`[mount-error] ${path}:`, e.message);
  }
}

function safeCallMount(mounter, label) {
  try {
    if (typeof mounter === "function") {
      mounter(app);
      console.log(`[mounted] ${label} (function-style)`);
    } else {
      console.warn(`[mount-skip] ${label}: not a function (got ${typeof mounter})`);
    }
  } catch (e) {
    console.error(`[mount-error] ${label}:`, e.message);
  }
}

// -------------------------------------------
// 4) Mount your real app routes (consistent)
// -------------------------------------------
// A) function-style routes (export a function(app)) → CALL them.
safeCallMount(require("./routes/users"), "users");
safeCallMount(require("./routes/fuel"), "fuel");
safeCallMount(require("./routes/service"), "service");
safeCallMount(require("./routes/documents"), "documents");
safeCallMount(require("./routes/reminders"), "reminders");
safeCallMount(require("./routes/reports"), "reports");
safeCallMount(require("./routes/whatsapp"), "whatsapp"); // /api/webhooks/whatsapp

// B) router-style routes (export an Express Router) → app.use(...)
const chatRoutes = require("./routes/chat");               // Router (reads pool via req.app.get('pool'))
safeUse("/api", chatRoutes);

const subscriptionsRoutes = require("./routes/subscriptions"); // Router
safeUse("/api/subscriptions", subscriptionsRoutes);

const billingRoutes = require("./routes/billing");             // Router
safeUse("/api/billing", billingRoutes);

const testEmailRoutes = require("./routes/testEmail");         // Router
safeUse("/api", testEmailRoutes);

const uploadsRoutes = require("./routes/uploads");             // Router
safeUse("/api/uploads", uploadsRoutes);

const adminEmailRoutes = require("./routes/adminEmails");      // Router
safeUse("/api/admin/email", adminEmailRoutes);

const paymentsRoutes = require("./routes/payments");           // Router (Paystack)
safeUse("/api/payments", paymentsRoutes);

// Optional dynamic mounts
try {
  const vehiclesRoutes = require("./routes/vehicles");         // Router
  safeUse("/api/vehicles", vehiclesRoutes);
} catch (_) {}

try {
  const affiliatesRoutes = require("./routes/affiliates");     // Router
  safeUse("/api/affiliates", affiliatesRoutes);
} catch (_) {}

try {
  const optionalPaymentsFn = require("./routes/payments_fn");  // function-style alt (if you ever had one)
  if (optionalPaymentsFn) safeCallMount(optionalPaymentsFn, "payments_fn");
} catch (_) {}

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// ---------- Global JSON error handler ----------
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  const status = err.status || 500;
  res.status(status).type("application/json").send({
    error: status === 404 ? "Not found" : "Server error",
    detail: process.env.DEBUG_MODE === "1" ? (err?.message || String(err)) : undefined,
    path: req.originalUrl,
  });
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
