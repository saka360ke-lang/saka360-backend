// routes/vehicles.js
const express = require("express");
const { authenticateToken } = require("../shared"); // if your shared exports authenticateToken
// If not, use: const { authenticateToken } = require("../middleware/auth");

const router = express.Router();
const normalizePlate = (plate) =>
  (plate || "").toString().replace(/[^A-Za-z0-9]/g, "").toUpperCase();

module.exports = (appOrNothing) => {
  // If this file is used as Router only, comment the next line and mount with app.use in index.js
  // If your project previously used app.use directly, keep it that way.
  const pool = appOrNothing?.get ? appOrNothing.get("pool") : null;

  // Fallback: if mounted as plain router via app.use("/api/vehicles", router)
  async function getPool(req) {
    return pool || req.app.get("pool");
  }

  // Add vehicle
  router.post("/add", authenticateToken, async (req, res) => {
    try {
      const pool = await getPool(req);
      const { name, plate_number, type, make, model, year_of_manufacture } = req.body || {};
      if (!name || !plate_number) return res.status(400).json({ error: "Name and plate_number required" });

      const plate_normalized = normalizePlate(plate_number);

      const q = await pool.query(
        `INSERT INTO vehicles (user_id, name, plate_number, type, make, model, year_of_manufacture, plate_normalized)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, name, plate_number, type, make, model, year_of_manufacture, plate_normalized, created_at`,
        [req.user.id, name, plate_number, type || null, make || null, model || null, year_of_manufacture || null, plate_normalized]
      );

      res.status(201).json({ vehicle: q.rows[0] });
    } catch (err) {
      console.error("vehicles.add error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // List my vehicles
  router.get("/mine", authenticateToken, async (req, res) => {
    try {
      const pool = await getPool(req);
      const q = await pool.query(
        `SELECT id, name, plate_number, type, make, model, year_of_manufacture, plate_normalized, created_at
           FROM vehicles
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [req.user.id]
      );
      res.json({ vehicles: q.rows });
    } catch (err) {
      console.error("vehicles.mine error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Assign vehicle to a driver or user
  router.post("/:vehicle_id/assign", authenticateToken, async (req, res) => {
    try {
      const pool = await getPool(req);
      const vehicle_id = parseInt(req.params.vehicle_id, 10);
      const { driver_id, assignee_user_id, start_date } = req.body || {};
      if (Number.isNaN(vehicle_id)) return res.status(400).json({ error: "Invalid vehicle_id" });
      if (!driver_id && !assignee_user_id) return res.status(400).json({ error: "Provide driver_id or assignee_user_id" });

      // ensure vehicle belongs to caller
      const v = await pool.query(`SELECT id FROM vehicles WHERE id=$1 AND user_id=$2`, [vehicle_id, req.user.id]);
      if (v.rows.length === 0) return res.status(404).json({ error: "Vehicle not found or not owned by user" });

      // deactivate existing active assignment(s)
      await pool.query(
        `UPDATE vehicle_assignments SET active=false, updated_at=NOW()
          WHERE vehicle_id=$1 AND active=true`,
        [vehicle_id]
      );

      const q = await pool.query(
        `INSERT INTO vehicle_assignments (vehicle_id, driver_id, assignee_user_id, start_date, active)
         VALUES ($1,$2,$3,$4::date, true)
         RETURNING *`,
        [vehicle_id, driver_id || null, assignee_user_id || null, start_date || new Date().toISOString().slice(0,10)]
      );

      res.json({ assignment: q.rows[0] });
    } catch (err) {
      console.error("vehicles.assign error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Unassign (close the active assignment)
  router.post("/:vehicle_id/unassign", authenticateToken, async (req, res) => {
    try {
      const pool = await getPool(req);
      const vehicle_id = parseInt(req.params.vehicle_id, 10);
      if (Number.isNaN(vehicle_id)) return res.status(400).json({ error: "Invalid vehicle_id" });
      const { end_date } = req.body || {};

      const v = await pool.query(`SELECT id FROM vehicles WHERE id=$1 AND user_id=$2`, [vehicle_id, req.user.id]);
      if (v.rows.length === 0) return res.status(404).json({ error: "Vehicle not found or not owned by user" });

      const q = await pool.query(
        `UPDATE vehicle_assignments
            SET active=false, end_date=$3::date, updated_at=NOW()
          WHERE vehicle_id=$1 AND active=true
          RETURNING *`,
        [vehicle_id, req.user.id, end_date || new Date().toISOString().slice(0,10)]
      );

      if (q.rows.length === 0) return res.status(404).json({ error: "No active assignment" });
      res.json({ assignment: q.rows[0] });
    } catch (err) {
      console.error("vehicles.unassign error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Find by flexible plate input
  router.get("/by-plate/:plate", authenticateToken, async (req, res) => {
    try {
      const pool = await getPool(req);
      const raw = req.params.plate || "";
      const norm = normalizePlate(raw);

      const q = await pool.query(
        `SELECT id, name, plate_number, type, make, model, year_of_manufacture
           FROM vehicles
          WHERE user_id=$1 AND plate_normalized=$2
          LIMIT 1`,
        [req.user.id, norm]
      );

      res.json({ vehicle: q.rows[0] || null });
    } catch (err) {
      console.error("vehicles.by-plate error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  return router;
};
