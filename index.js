// index.js
require("dotenv").config();

const express = require("express");
const app = express();

app.set("trust proxy", 1);

// --- IMPORTANT: Skip JSON body parsing for the Paystack webhook path
app.use((req, res, next) => {
  if (req.path === "/api/payments/webhook") return next();
  return express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === "/api/payments/webhook") return next();
  return express.urlencoded({ extended: false })(req, res, next);
});

// Malformed JSON → JSON error
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }
  next(err);
});

const morgan = require("morgan");
app.use(morgan("tiny"));

// Health
app.get("/api/health", (_req, res) => res.status(200).json({ status: "OK" }));

// Security/cors/rate-limit
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
app.use(helmet());

const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
}));

// DB
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

// Mailers & reminders
const { verifySmtp, sendEmail } = require("./utils/mailer");
const { runExpiryCheckCore } = require("./utils/reminders");

// Twilio helpers omitted here (as before)...

const { authenticateToken, adminOnly } = require("./middleware/auth");

// Admin email test endpoints (already working)...
const adminEmailRoutes = require("./routes/adminEmails");
app.use("/api/admin/email", adminEmailRoutes);

// Function-style routes
require("./routes/users")(app);
require("./routes/fuel")(app);
require("./routes/service")(app);
require("./routes/documents")(app);
require("./routes/reminders")(app);
require("./routes/reports")(app);
require("./routes/whatsapp")(app);

// Router-style
const chatRoutes = require("./routes/chat");
app.use("/api", chatRoutes);

const uploadsRoutes = require("./routes/uploads");
app.use("/api/uploads", uploadsRoutes);

// Payments (router)
const paymentsRoutes = require("./routes/payments");
app.use("/api/payments", paymentsRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// Global error
app.use((err, req, res, _next) => {
  console.error("[unhandled]", err);
  const status = err.status || 500;
  res.status(status).type("application/json").send({
    error: status === 404 ? "Not found" : "Server error",
    detail: process.env.DEBUG_MODE === "1" ? err?.message || String(err) : undefined,
    path: req.originalUrl,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
