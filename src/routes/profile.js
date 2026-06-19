const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const userService = require('../services/userService');

// GET /api/profile/:userId — Public profile
router.get('/:userId', telegramAuth, async (req, res, next) => {
  try {
    const profile = await userService.getPublicProfile(parseInt(req.params.userId));
    if (!profile) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    res.json({ success: true, data: profile });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
