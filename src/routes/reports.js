const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const { rateLimiters } = require('../middleware/rateLimit');
const reportService = require('../services/reportService');

// POST /api/report — Report a player
router.post('/', telegramAuth, rateLimiters.reportPlayer, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { reported_id, match_id, reason, description } = req.body;
    if (!reported_id || !reason) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'reported_id and reason are required.' } });
    }
    const result = await reportService.reportPlayer(req.user.id, reported_id, match_id, reason, description);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
