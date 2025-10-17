// routes/testEmail.js
const express = require("express");
const { sendEmail } = require("../utils/mailer");

module.exports = (app) => {
  const router = express.Router();

  /**
   * Test any email template manually
   * POST /api/test-email
   * Body: { "to": "example@gmail.com", "template": "verification" }
   */
  router.post("/test-email", async (req, res) => {
    try {
      const { to, template } = req.body;

      const sampleData = {
        verification: {
          verification_link: "https://saka360.com/verify?token=TEST123"
        },
        invoice: {
          user_name: "John Doe",
          plan_name: "Premium",
          amount: "2500",
          date: "01/10/2025"
        },
        payout: {
          affiliate_name: "Jane Influencer",
          month_period: "September 2025",
          bookings_count: 18,
          commission_amount: "7200",
          payout_date: "Oct 5, 2025"
        },
        "monthly-report": {
          user_name: "Fleet Owner",
          report_month: "September 2025",
          total_fuel: "52,000",
          total_service: "18,000",
          grand_total: "70,000",
          download_link: "https://saka360.com/download/report123"
        }
      };

      if (!sampleData[template]) {
        return res.status(400).json({
          error: "Invalid template name. Must be one of: verification, invoice, payout, monthly-report"
        });
      }

      await sendEmail(
        to,
        `Saka360 Test – ${template}`,
        template, // the .hbs template name (without extension)
        sampleData[template] // data context
      );

      res.json({ message: `✅ Test ${template} email sent successfully`, to });
    } catch (err) {
      console.error("Test email error:", err);
      res.status(500).json({
        error: "Failed to send test email",
        detail: err.message
      });
    }
  });

  // Mount under /api
  app.use("/api", router);
};
