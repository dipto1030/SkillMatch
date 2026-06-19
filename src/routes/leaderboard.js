const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const scoreService = require('../services/scoreService');

// GET /api/leaderboard/:gameId — Game skill score leaderboard
router.get('/:gameId', telegramAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const leaderboard = await scoreService.getLeaderboard(parseInt(req.params.gameId), limit);
    res.json({ success: true, data: leaderboard });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
