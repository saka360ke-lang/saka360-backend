// routes/testemail.js
const express = require('express');
const router = express.Router();

// use your existing mailer helpers
const { sendEmail, verifySmtp } = require('../utils/mailer');

// GET /api/email-verify  -> checks SMTP connection
router.get('/email-verify', async (_req, res) => {
  try {
    const ok = await verifySmtp();
    res.json({ ok, message: 'SMTP connection OK ✅' });
  } catch (err) {
    console.error('SMTP verify error:', err);
    res.status(500).json({ ok: false, error: 'SMTP verification failed', detail: err.message });
  }
});

// GET /api/test-email -> sends a simple text email
router.get('/test-email', async (_req, res) => {
  try {
    const to = 'huguadventures@gmail.com'; // change if you want
    await sendEmail(
      to,
      'Saka360 Plain Test Email',
      null, // null template => plain text body
      'Hello! 👋 This is a public test email from Saka360 backend.'
    );
    res.json({ message: 'Plain test email sent ✅', to });
  } catch (err) {
    console.error('Test email error:', err);
    res.status(500).json({ error: 'Failed to send test email', detail: err.message });
  }
});

module.exports = (app) => {
  // mount under /api
  app.use('/api', router);
};
