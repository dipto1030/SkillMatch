const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const { rateLimiters } = require('../middleware/rateLimit');
const disputeService = require('../services/disputeService');
const multer = require('multer');
const path = require('path');
const env = require('../config/env');

const upload = multer({
  dest: path.join(env.UPLOAD_DIR, 'evidence'),
  limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 },
});

// POST /api/disputes — Raise dispute on a match
router.post('/', telegramAuth, rateLimiters.createDispute, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { match_id } = req.body;
    const dispute = await disputeService.create(req.user.id, match_id);
    res.status(201).json({ success: true, data: dispute });
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/pay-stake — Pay dispute stake
router.post('/:id/pay-stake', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const dispute = await disputeService.payStake(req.user.id, parseInt(req.params.id));
    res.json({ success: true, data: dispute });
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/select-track — Choose standard or fast-track
router.post('/:id/select-track', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { track } = req.body;
    const dispute = await disputeService.selectTrack(req.user.id, parseInt(req.params.id), track);
    res.json({ success: true, data: dispute });
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/evidence — Upload evidence file
router.post('/:id/evidence', telegramAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    if (!req.file) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'File required.' } });

    const fileUrl = `/uploads/evidence/${req.file.filename}`;
    const fileType = req.body.file_type || 'screenshot';
    await disputeService.uploadEvidence(req.user.id, parseInt(req.params.id), fileUrl, fileType);
    res.json({ success: true, data: { file_url: fileUrl } });
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/escalate — Escalate post-jury to admin
router.post('/:id/escalate', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const result = await disputeService.escalateToAdmin(req.user.id, parseInt(req.params.id));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/disputes/:id — Dispute status
router.get('/:id', telegramAuth, async (req, res, next) => {
  try {
    const db = require('../config/database');
    const { rows } = await db.query('SELECT * FROM disputes WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Dispute not found.' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
