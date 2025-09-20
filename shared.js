// shared.js
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

// DB Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access denied. Token required." });

  jwt.verify(token, process.env.JWT_SECRET || "supersecretkey", (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token" });
    req.user = user;
    next();
  });
}

module.exports = { pool, authenticateToken };
