const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();

// Combined Vehicle Report
router.get('/vehicles/report/:vehicle_id', authenticateToken, async (req, res) => {
  try {
    const { vehicle_id } = req.params;
    const check = await pool.query(
      `SELECT id, name FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, req.user.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found or not owned by user' });

    const [fuel, service] = await Promise.all([
      pool.query(`SELECT amount, liters, price_per_liter, odometer, created_at FROM fuel_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at ASC`, [req.user.id, vehicle_id]),
      pool.query(`SELECT description, cost, odometer, created_at FROM service_logs WHERE user_id=$1 AND vehicle_id=$2 ORDER BY created_at ASC`, [req.user.id, vehicle_id])
    ]);

    const fuel_logs = fuel.rows;
    const service_logs = service.rows;
    const total_fuel = fuel_logs.reduce((s, r) => s + Number(r.amount), 0);
    const total_service = service_logs.reduce((s, r) => s + Number(r.cost), 0);

    res.json({ vehicle_id, fuel_logs, service_logs, totals: { total_fuel, total_service, grand_total: total_fuel + total_service } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fleet Report (JSON)
router.get('/fleet/report', authenticateToken, async (req, res) => {
  try {
    const vehicles = await pool.query(`SELECT id, name, type, plate_number FROM vehicles WHERE user_id = $1`, [req.user.id]);
    if (vehicles.rows.length === 0) return res.json({ vehicles: [], fleet_totals: null });

    let reports = [];
    for (let v of vehicles.rows) {
      const fuel = await pool.query(`SELECT amount, liters FROM fuel_logs WHERE user_id=$1 AND vehicle_id=$2`, [req.user.id, v.id]);
      const service = await pool.query(`SELECT cost FROM service_logs WHERE user_id=$1 AND vehicle_id=$2`, [req.user.id, v.id]);

      const total_fuel = fuel.rows.reduce((s, r) => s + Number(r.amount), 0);
      const total_service = service.rows.reduce((s, r) => s + Number(r.cost), 0);

      reports.push({ vehicle_id: v.id, name: v.name, plate_number: v.plate_number, totals: { total_fuel, total_service, grand_total: total_fuel + total_service } });
    }

    const fleet_totals = {
      total_fuel: reports.reduce((s, r) => s + r.totals.total_fuel, 0),
      total_service: reports.reduce((s, r) => s + r.totals.total_service, 0),
      grand_total: reports.reduce((s, r) => s + r.totals.grand_total, 0)
    };

    res.json({ vehicles: reports, fleet_totals });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Fleet Report (PDF)
router.get('/fleet/report/pdf', authenticateToken, async (req, res) => {
  try {
    const vehicles = await pool.query(`SELECT id, name, plate_number FROM vehicles WHERE user_id = $1`, [req.user.id]);
    if (vehicles.rows.length === 0) return res.status(404).json({ error: 'No vehicles found' });

    let reports = [];
    for (let v of vehicles.rows) {
      const fuel = await pool.query(`SELECT amount, liters FROM fuel_logs WHERE user_id=$1 AND vehicle_id=$2`, [req.user.id, v.id]);
      const service = await pool.query(`SELECT cost FROM service_logs WHERE user_id=$1 AND vehicle_id=$2`, [req.user.id, v.id]);

      const total_fuel = fuel.rows.reduce((s, r) => s + Number(r.amount), 0);
      const total_service = service.rows.reduce((s, r) => s + Number(r.cost), 0);

      reports.push({ name: v.name, plate: v.plate_number, totals: { total_fuel, total_service, grand_total: total_fuel + total_service } });
    }

    const fleet_totals = {
      total_fuel: reports.reduce((s, r) => s + r.totals.total_fuel, 0),
      total_service: reports.reduce((s, r) => s + r.totals.total_service, 0),
      grand_total: reports.reduce((s, r) => s + r.totals.grand_total, 0)
    };

    const doc = new PDFDocument();
    res.setHeader('Content-disposition', 'attachment; filename=fleet_report.pdf');
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(18).text("Fleet Report", { align: 'center' }).moveDown();
    reports.forEach((r, i) => {
      doc.fontSize(14).text(`Vehicle ${i+1}: ${r.name} (${r.plate})`);
      doc.fontSize(12).list([
        `Total Fuel: KES ${r.totals.total_fuel}`,
        `Total Service: KES ${r.totals.total_service}`,
        `Grand Total: KES ${r.totals.grand_total}`
      ]);
      doc.moveDown();
    });

    doc.fontSize(16).text("Fleet Totals", { underline: true }).moveDown();
    doc.fontSize(12).list([
      `Total Fuel: KES ${fleet_totals.total_fuel}`,
      `Total Service: KES ${fleet_totals.total_service}`,
      `Grand Total: KES ${fleet_totals.grand_total}`
    ]);

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'PDF generation failed' });
  }
});

module.exports = (app, pool, authenticateToken) => app.use('/api', router);
