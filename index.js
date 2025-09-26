// Load environment variables
require('dotenv').config();

// Mailer
const { sendEmail } = require("./utils/mailer");

app.post("/api/users/register", async (req, res) => {
  try {
    const { email, name } = req.body;

    // Generate a fake verification link for demo
    const verificationLink = `https://saka360.com/verify?token=12345`;

    // Call the email utility
    await sendEmail(
      email,
      "Verify your Saka360 account",
      "verification", // template file name (verification.hbs)
      { verification_link: verificationLink }
    );

    res.json({ message: "User registered. Verification email sent ✅" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

await sendEmail(
  user.email,
  "Your Saka360 Subscription Invoice",
  "invoice", // invoice.hbs
  {
    user_name: user.name,
    plan_name: "Premium",
    amount: "2500",
    date: new Date().toLocaleDateString()
  }
);

// Core
const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');

// Third-party
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const twilio = require('twilio');

// AWS S3
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(express.json());

// Example: database connection (uses env var)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Simple test route
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: "OK", db: "connected", time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: "ERROR", message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
