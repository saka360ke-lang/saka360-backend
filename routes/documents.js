// routes/documents.js
const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { signGetUrl, safeDeleteObject } = require('../utils/s3');

module.exports = (app) => {
  const router = express.Router();
  const pool = app.get('pool'); // shared pg pool from index.js

  /** Utility: verify vehicle belongs to user */
  async function assertVehicleOwner(pool, vehicle_id, user_id) {
    const v = await pool.query(
      `SELECT id FROM vehicles WHERE id = $1 AND user_id = $2`,
      [vehicle_id, user_id]
    );
    if (v.rows.length === 0) {
      const e = new Error('Vehicle not found or not owned by user');
      e.status = 403;
      throw e;
    }
  }

  /** Utility: get file_id from file_key (s3_key) safely for user */
  async function fileIdFromKey(pool, user_id, file_key) {
    if (!file_key) return null;
    const q = await pool.query(
      `SELECT id FROM files WHERE user_id = $1 AND s3_key = $2 LIMIT 1`,
      [user_id, file_key]
    );
    if (q.rows.length === 0) {
      const e = new Error('File not found (or not owned by user). Did you /finalize after upload?');
      e.status = 400;
      throw e;
    }
    return q.rows[0].id;
  }

  /** *******************************
   * 1) CREATE document (+ optional file)
   * POST /api/docs/add
   * Body: { vehicle_id, doc_type, number?, expiry_date, file_key? OR file_id? }
   ******************************** */
  router.post('/add', authenticateToken, async (req, res) => {
    try {
      let { vehicle_id, doc_type, number, expiry_date, file_key, file_id } = req.body || {};

      if (!vehicle_id || !doc_type || !expiry_date) {
        return res.status(400).json({
          error: 'Vehicle ID, document type, and expiry date are required',
        });
      }
      vehicle_id = parseInt(vehicle_id, 10);
      if (Number.isNaN(vehicle_id)) {
        return res.status(400).json({ error: 'vehicle_id must be a number' });
      }

      await assertVehicleOwner(pool, vehicle_id, req.user.id);

      // If client passed file_key (S3 key), look up its ID (must belong to user)
      if (!file_id && file_key) {
        file_id = await fileIdFromKey(pool, req.user.id, file_key);
      }

      const result = await pool.query(
        `INSERT INTO documents (user_id, vehicle_id, doc_type, number, expiry_date, file_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, vehicle_id, doc_type, number, expiry_date, file_id, created_at`,
        [req.user.id, vehicle_id, doc_type, number || null, expiry_date, file_id || null]
      );

      return res.status(201).json({ document: result.rows[0] });
    } catch (err) {
      console.error('Documents /add error:', err);
      return res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
  });

  /** *******************************
   * 2) UPDATE document metadata
   * PATCH /api/docs/:id
   * Body: { doc_type?, number?, expiry_date? }
   ******************************** */
  router.patch('/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid document id' });

      // Ensure ownership
      const doc = await pool.query(
        `SELECT id, user_id FROM documents WHERE id = $1 AND user_id = $2`,
        [id, req.user.id]
      );
      if (doc.rows.length === 0) return res.status(404).json({ error: 'Document not found' });

      const { doc_type, number, expiry_date } = req.body || {};
      const r = await pool.query(
        `UPDATE documents
           SET doc_type = COALESCE($2, doc_type),
               number   = COALESCE($3, number),
               expiry_date = COALESCE($4, expiry_date)
         WHERE id = $1 AND user_id = $5
         RETURNING id, vehicle_id, doc_type, number, expiry_date, file_id, created_at`,
        [id, doc_type || null, number || null, expiry_date || null, req.user.id]
      );

      return res.json({ document: r.rows[0] });
    } catch (err) {
      console.error('Documents /:id PATCH error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  /** *******************************
   * 3) REPLACE a document’s file
   * PATCH /api/docs/:id/replace-file
   * Body: { new_file_key? OR new_file_id? }
   * - Attaches the new file
   * - Deletes the old file from S3 & files table (safe, best-effort)
   ******************************** */
  router.patch('/:id/replace-file', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid document id' });

      const { new_file_key, new_file_id } = req.body || {};
      if (!new_file_key && !new_file_id) {
        return res.status(400).json({ error: 'Provide new_file_key or new_file_id' });
      }

      await client.query('BEGIN');

      // Check doc & ownership
      const docQ = await client.query(
        `SELECT id, user_id, file_id FROM documents WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, req.user.id]
      );
      if (docQ.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Document not found' });
      }
      const oldFileId = docQ.rows[0].file_id;

      // Resolve new file id (must belong to user)
      let targetFileId = new_file_id || null;
      if (!targetFileId && new_file_key) {
        const f = await client.query(
          `SELECT id FROM files WHERE user_id = $1 AND s3_key = $2 LIMIT 1`,
          [req.user.id, new_file_key]
        );
        if (f.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'New file not found (or not owned by user)' });
        }
        targetFileId = f.rows[0].id;
      }

      // Attach new file
      const upd = await client.query(
        `UPDATE documents SET file_id = $2 WHERE id = $1 RETURNING id, vehicle_id, doc_type, number, expiry_date, file_id, created_at`,
        [id, targetFileId]
      );

      // Fetch old file key then delete S3 + files row (best-effort)
      if (oldFileId) {
        const oldF = await client.query(
          `SELECT id, s3_key FROM files WHERE id = $1 AND user_id = $2`,
          [oldFileId, req.user.id]
        );
        if (oldF.rows.length) {
          const oldKey = oldF.rows[0].s3_key;
          try {
            await safeDeleteObject(oldKey); // S3
          } catch (_) {}
          // Remove file row
          await client.query(`DELETE FROM files WHERE id = $1 AND user_id = $2`, [oldFileId, req.user.id]);
        }
      }

      await client.query('COMMIT');
      return res.json({ document: upd.rows[0], replaced_file_id: oldFileId || null });
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error('Documents replace-file error:', err);
      return res.status(500).json({ error: 'Failed to replace file' });
    } finally {
      client.release();
    }
  });

  /** *******************************
   * 4) DELETE a document (optional delete file too)
   * DELETE /api/docs/:id?delete_file=1
   ******************************** */
  router.delete('/:id', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
      const id = parseInt(req.params.id, 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid document id' });

      const deleteFile = String(req.query.delete_file || '0') === '1';

      await client.query('BEGIN');

      // Get doc & ownership
      const docQ = await client.query(
        `SELECT id, file_id FROM documents WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, req.user.id]
      );
      if (docQ.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Document not found' });
      }

      const fileId = docQ.rows[0].file_id;

      // Delete document
      await client.query(`DELETE FROM documents WHERE id = $1 AND user_id = $2`, [id, req.user.id]);

      // Optional: delete attached file
      if (deleteFile && fileId) {
        const f = await client.query(
          `SELECT id, s3_key FROM files WHERE id = $1 AND user_id = $2`,
          [fileId, req.user.id]
        );
        if (f.rows.length) {
          const key = f.rows[0].s3_key;
          try {
            await safeDeleteObject(key);
          } catch (_) {}
          await client.query(`DELETE FROM files WHERE id = $1 AND user_id = $2`, [fileId, req.user.id]);
        }
      }

      await client.query('COMMIT');
      return res.json({ ok: true, deleted: id, file_deleted: deleteFile && !!fileId });
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error('Documents DELETE error:', err);
      return res.status(500).json({ error: 'Failed to delete document' });
    } finally {
      client.release();
    }
  });

  /** *******************************
   * 5) LIST history (adds optional signed URL)
   * GET /api/docs/history/:vehicle_id?include_url=1&download=1
   ******************************** */
  router.get('/history/:vehicle_id', authenticateToken, async (req, res) => {
    try {
      const vehicle_id = parseInt(req.params.vehicle_id, 10);
      if (Number.isNaN(vehicle_id)) {
        return res.status(400).json({ error: 'vehicle_id must be a number' });
      }

      await assertVehicleOwner(pool, vehicle_id, req.user.id);

      const result = await pool.query(
        `SELECT d.id, d.vehicle_id, d.doc_type, d.number, d.expiry_date, d.created_at,
                f.id AS file_id, f.s3_key, f.content_type, f.size_bytes, f.label
           FROM documents d
           LEFT JOIN files f ON f.id = d.file_id
          WHERE d.user_id = $1 AND d.vehicle_id = $2
          ORDER BY d.expiry_date ASC NULLS LAST, d.created_at DESC`,
        [req.user.id, vehicle_id]
      );

      const includeUrl = String(req.query.include_url || '0') === '1';
      const download = String(req.query.download || '0') === '1';

      const today = new Date();
      const documents = await Promise.all(
        result.rows.map(async (doc) => {
          const days_left =
            doc.expiry_date ? Math.ceil((new Date(doc.expiry_date) - today) / (1000 * 60 * 60 * 24)) : null;

          let file_url = null;
          if (includeUrl && doc.s3_key) {
            try {
              file_url = (await signGetUrl({
                key: doc.s3_key,
                expiresIn: 300,
                contentDisposition: download ? 'attachment' : undefined,
              })).url;
            } catch (e) {
              console.error('signGetUrl in history error:', e.message);
            }
          }

          return {
            id: doc.id,
            vehicle_id: doc.vehicle_id,
            doc_type: doc.doc_type,
            number: doc.number,
            expiry_date: doc.expiry_date,
            created_at: doc.created_at,
            days_left,
            file: doc.file_id
              ? {
                  id: doc.file_id,
                  s3_key: doc.s3_key,
                  content_type: doc.content_type,
                  size_bytes: doc.size_bytes,
                  label: doc.label,
                  url: file_url, // may be null if include_url=0 or signing failed
                }
              : null,
          };
        })
      );

      return res.json({ documents });
    } catch (err) {
      console.error('Documents /history error:', err);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // Mount this router under /api/docs
  app.use('/api/docs', router);
};
