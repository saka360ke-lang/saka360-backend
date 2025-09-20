const express = require("express");
const { pool, authenticateToken } = require("../shared");

const router = express.Router();

// Add vehicle
router.post("/add", authenticateToken, async (req, res) => {
  try {
    const { name, plate_number, type } = req.body;
    if (!name || !plate_number) return res.status(400).json({ error: "Name and plate number are required" });

    const result = await pool.query(
      `INSERT INTO vehicles (user_id, name, plate_number, type)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, plate_number, type, created_at`,
      [req.user.id, name, plate_number, type || null]
    );

    res.status(201).json({ vehicle: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
