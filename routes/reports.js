// routes/reports.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const PDFDocument = require('pdfkit');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool');

  // Existing 1) Vehicle combined JSON
  router.get('/vehicles/report/:vehicle_id', authenticateToken, async (req, res) => {
    try {
      const { vehicle_id } = req.params;

      const check = await pool.query(
        `SELECT id, name, plate_number, make, model, year_of_manufacture
           FROM vehicles WHERE id = $1 AND user_id = $2`,
        [vehicle_id, req.user.id]
      );
      if (check.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found or not owned by user' });
      const vehicle = check.rows[0];

      const [fuel, service] = await Promise.all([
        pool.query(
          `SELECT id, amount, liters, price_per_liter, odometer, created_at
             FROM fuel_logs
            WHERE user_id = $1 AND vehicle_id = $2
            ORDER BY created_at ASC`,
          [req.user.id, vehicle_id]
        ),
        pool.query(
          `SELECT id, description, cost, odometer, created_at
             FROM service_logs
            WHERE user_id = $1 AND vehicle_id = $2
            ORDER BY created_at ASC`,
          [req.user.id, vehicle_id]
        )
      ]);

      const fuel_logs = fuel.rows;
      const service_logs = service.rows;
      const total_fuel_spend = fuel_logs.reduce((s, r) => s + Number(r.amount || 0), 0);
      const total_liters = fuel_logs.reduce((s, r) => s + Number(r.liters || 0), 0);
      const avg_price_per_liter = total_liters > 0 ? total_fuel_spend / total_liters : null;
      const total_service_spend = service_logs.reduce((s, r) => s + Number(r.cost || 0), 0);

      let distance = null, cost_per_km = null;
      if (fuel_logs.length >= 2) {
        const first_odometer = fuel_logs[0].odometer;
        const last_odometer = fuel_logs[fuel_logs.length - 1].odometer;
        distance = last_odometer - first_odometer;
        cost_per_km = distance > 0 ? total_fuel_spend / distance : null;
      }

      res.json({
        vehicle,
        fuel_logs,
        service_logs,
        totals: {
          total_fuel_spend,
          total_liters,
          avg_price_per_liter,
          total_service_spend,
          distance,
          cost_per_km,
          grand_total: total_fuel_spend + total_service_spend
        }
      });
    } catch (err) {
      console.error('Vehicle report error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Existing 2) Fleet JSON (supports from/to)
  router.get('/fleet/report', authenticateToken, async (req, res) => {
    try {
      const { from, to } = req.query;

      const vehicles = await pool.query(
        `SELECT id, name, type, plate_number
           FROM vehicles
          WHERE user_id = $1
          ORDER BY created_at ASC`,
        [req.user.id]
      );

      if (vehicles.rows.length === 0) return res.json({ vehicles: [], fleet_totals: null });

      let dateFilter = '';
      const paramsExtra = [];
      if (from && to) { dateFilter = `AND created_at BETWEEN $3 AND $4`; paramsExtra.push(from, to); }
      else if (from)  { dateFilter = `AND created_at >= $3`; paramsExtra.push(from); }
      else if (to)    { dateFilter = `AND created_at <= $3`; paramsExtra.push(to); }

      const reports = [];
      for (const v of vehicles.rows) {
        const fuel = await pool.query(
          `SELECT amount, liters, price_per_liter, odometer, created_at
             FROM fuel_logs
            WHERE user_id = $1 AND vehicle_id = $2 ${dateFilter}
            ORDER BY created_at ASC`,
          [req.user.id, v.id, ...paramsExtra]
        );

        const service = await pool.query(
          `SELECT description, cost, odometer, created_at
             FROM service_logs
            WHERE user_id = $1 AND vehicle_id = $2 ${dateFilter}
            ORDER BY created_at ASC`,
          [req.user.id, v.id, ...paramsExtra]
        );

        const fuel_logs = fuel.rows;
        const service_logs = service.rows;

        const total_fuel = fuel_logs.reduce((s, r) => s + Number(r.amount || 0), 0);
        const total_liters = fuel_logs.reduce((s, r) => s + Number(r.liters || 0), 0);
        const avg_price_per_liter = total_liters > 0 ? total_fuel / total_liters : null;
        const total_service = service_logs.reduce((s, r) => s + Number(r.cost || 0), 0);

        reports.push({
          vehicle_id: v.id,
          name: v.name,
          type: v.type,
          plate_number: v.plate_number,
          totals: {
            total_fuel,
            total_service,
            grand_total: total_fuel + total_service,
            avg_price_per_liter
          }
        });
      }

      const fleet_totals = {
        total_fuel: reports.reduce((s, r) => s + r.totals.total_fuel, 0),
        total_service: reports.reduce((s, r) => s + r.totals.total_service, 0),
        grand_total: reports.reduce((s, r) => s + r.totals.grand_total, 0)
      };

      res.json({ vehicles: reports, fleet_totals });
    } catch (err) {
      console.error('Fleet report error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Existing 3) Fleet PDF
  router.get('/fleet/report/pdf', authenticateToken, async (req, res) => {
    try {
      const vehicles = await pool.query(
        `SELECT id, name, type, plate_number
           FROM vehicles
          WHERE user_id = $1
          ORDER BY created_at ASC`,
        [req.user.id]
      );
      if (vehicles.rows.length === 0) return res.status(404).json({ error: 'No vehicles found' });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename=fleet_report.pdf`);
      const doc = new PDFDocument();
      doc.pipe(res);

      doc.fontSize(18).text('Saka360 Fleet Report', { align: 'center' });
      doc.moveDown();

      let fleetTotalFuel = 0;
      let fleetTotalService = 0;

      for (const v of vehicles.rows) {
        const fuel = await pool.query(
          `SELECT COALESCE(SUM(amount),0) AS total_amount,
                  COALESCE(SUM(liters),0) AS total_liters
             FROM fuel_logs
            WHERE vehicle_id = $1 AND user_id = $2`,
          [v.id, req.user.id]
        );

        const service = await pool.query(
          `SELECT COALESCE(SUM(cost),0) AS total_cost,
                  COUNT(*) AS count
             FROM service_logs
            WHERE vehicle_id = $1 AND user_id = $2`,
          [v.id, req.user.id]
        );

        const fa = Number(fuel.rows[0].total_amount);
        const fl = Number(fuel.rows[0].total_liters);
        const sc = Number(service.rows[0].total_cost);
        const scount = Number(service.rows[0].count);

        fleetTotalFuel += fa;
        fleetTotalService += sc;

        doc.fontSize(14).text(`Vehicle: ${v.name} (${v.plate_number})`, { underline: true });
        doc.fontSize(12)
          .text(`Total Fuel Spend: KES ${fa.toFixed(2)}`)
          .text(`Total Fuel Liters: ${fl.toFixed(2)}`)
          .text(`Total Service Spend: KES ${sc.toFixed(2)}`)
          .text(`Number of Services: ${scount}`)
          .moveDown();
      }

      doc.moveDown();
      doc.fontSize(16).text('Fleet Totals', { underline: true });
      doc.fontSize(12)
        .text(`Total Fuel Spend: KES ${fleetTotalFuel.toFixed(2)}`)
        .text(`Total Service Spend: KES ${fleetTotalService.toFixed(2)}`)
        .text(`Grand Total: KES ${(fleetTotalFuel + fleetTotalService).toFixed(2)}`);

      doc.end();
    } catch (err) {
      console.error('Fleet report PDF error:', err);
      res.status(500).json({ error: 'PDF generation failed' });
    }
  });

  // NEW 4) Monthly summary for a vehicle (JSON)
  router.get('/vehicles/report/:vehicle_id/monthly', authenticateToken, async (req, res) => {
    try {
      const { vehicle_id } = req.params;
      const check = await pool.query(
        `SELECT id FROM vehicles WHERE id=$1 AND user_id=$2`,
        [vehicle_id, req.user.id]
      );
      if (check.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found or not owned by user' });

      const monthlyFuel = await pool.query(
        `SELECT to_char(created_at, 'YYYY-MM') AS ym,
                SUM(amount)::numeric(12,2) AS fuel_spend,
                SUM(liters)::numeric(12,2) AS liters
           FROM fuel_logs
          WHERE user_id=$1 AND vehicle_id=$2
          GROUP BY 1
          ORDER BY 1 DESC`,
        [req.user.id, vehicle_id]
      );
      const monthlyService = await pool.query(
        `SELECT to_char(created_at, 'YYYY-MM') AS ym,
                SUM(cost)::numeric(12,2) AS service_spend,
                COUNT(*) AS service_count
           FROM service_logs
          WHERE user_id=$1 AND vehicle_id=$2
          GROUP BY 1
          ORDER BY 1 DESC`,
        [req.user.id, vehicle_id]
      );

      res.json({ fuel: monthlyFuel.rows, service: monthlyService.rows });
    } catch (err) {
      console.error("vehicle monthly error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // NEW 5) Active assignment snapshot
  router.get('/vehicles/:vehicle_id/assignment', authenticateToken, async (req, res) => {
    try {
      const { vehicle_id } = req.params;
      const check = await pool.query(
        `SELECT id FROM vehicles WHERE id=$1 AND user_id=$2`,
        [vehicle_id, req.user.id]
      );
      if (check.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found or not owned by user' });

      const a = await pool.query(
        `SELECT va.*, d.name AS driver_name, d.phone AS driver_phone, u.name AS assignee_name, u.email AS assignee_email
           FROM vehicle_assignments va
           LEFT JOIN drivers d ON d.id = va.driver_id
           LEFT JOIN users u ON u.id = va.assignee_user_id
          WHERE va.vehicle_id = $1 AND va.active = true
          ORDER BY va.created_at DESC
          LIMIT 1`,
        [vehicle_id]
      );

      res.json({ assignment: a.rows[0] || null });
    } catch (err) {
      console.error("assignment error:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  app.use('/api/reports', router);
};
