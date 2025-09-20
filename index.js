require("dotenv").config();

const express = require("express");
const cron = require("node-cron");


const app = express();
app.use(express.json());

// Mount routes
app.use("/api/users", require("./routes/users"));
app.use("/api/vehicles", require("./routes/vehicles"));
app.use("/api/fuel", require("./routes/fuel"));
app.use("/api/service", require("./routes/service"));
app.use("/api/docs", require("./routes/documents"));
app.use("/api/reminders", require("./routes/reminders"));
app.use("/api/reports", require("./routes/reports"));

// Health check
app.get("/api/health", (req, res) => res.json({ status: "OK" }));

// Cron jobs (e.g. runExpiryCheck)
cron.schedule("0 8 * * *", () => {
  console.log("⏰ Running daily tasks...");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
