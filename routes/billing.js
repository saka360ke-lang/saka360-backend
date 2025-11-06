// routes/billing.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../middleware/auth");
const { getUserPlan, rulesFor } = require("../middleware/planGuard");

function getPool(req) { return req.app.get("pool"); }

router.get("/status", authenticateToken, async (req, res) => {
  try {
    const pool = getPool(req);
    const userId = req.user.id;

    const planCode = await getUserPlan(pool, userId);
    const limits  = rulesFor(planCode);

    const vQ = await pool.query(
      `SELECT COUNT(*)::int AS c FROM public.vehicles WHERE user_id=$1`,
      [userId]
    );
    const dQ = await pool.query(
      `SELECT COUNT(*)::int AS c FROM public.documents WHERE user_id=$1`,
      [userId]
    );

    res.json({
      plan: { code: planCode, ...limits },
      usage: {
        vehicles: vQ.rows[0]?.c || 0,
        documents: dQ.rows[0]?.c || 0
      }
    });
  } catch (e) {
    console.error("billing.status error:", e);
    res.status(500).json({ error: "Failed to load billing status" });
  }
});

module.exports = router;
