// routes/vehicles.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { planGuard } = require("../middleware/planGuard");

function getPool(req) {
  return req.app.get("pool");
}

// List vehicles for the logged-in user
router.get("/", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const userId = req.user.id;
    const r = await pool.query(
      `SELECT id, name, plate_number, type, make, model, year_of_manufacture
         FROM public.vehicles
        WHERE user_id=$1
        ORDER BY id DESC`,
      [userId]
    );
    res.json({ vehicles: r.rows });
  } catch (e) {
    console.error("vehicles.list error:", e);
    res.status(500).json({ error: "Failed to list vehicles" });
  }
});

// Create vehicle (guarded by plan limits)
router.post(
  "/",
  authenticateToken,
  (req, _res, next) => { req.enforceMaxVehicles = true; next(); },
  planGuard(),
  async (req, res) => {
    try {
      const pool = getPool(req);
      const userId = req.user.id;
      const {
        name,
        plate_number,
        type = "car",
        make,
        model,
        year_of_manufacture
      } = req.body || {};

      if (!plate_number) return res.status(400).json({ error: "plate_number is required" });

      const r = await pool.query(
        `INSERT INTO public.vehicles (user_id, name, plate_number, type, make, model, year_of_manufacture)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, name, plate_number, type, make, model, year_of_manufacture`,
        [userId, name || null, plate_number, type, make || null, model || null, year_of_manufacture || null]
      );
      res.json({ vehicle: r.rows[0] });
    } catch (e) {
      console.error("vehicles.create error:", e);
      res.status(500).json({ error: "Failed to create vehicle", detail: e.message });
    }
  }
);

module.exports = router;
