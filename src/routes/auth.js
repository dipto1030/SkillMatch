const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const userService = require('../services/userService');

// GET /api/me — User profile + wallet summary
router.get('/me', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      return res.json({ success: true, data: { registered: false, telegramUser: req.telegramUser } });
    }
    const wallet = await userService.getWalletSummary(req.user.id);
    res.json({ success: true, data: { registered: true, user: req.user, wallet } });
  } catch (err) {
    next(err);
  }
});

// POST /api/register — Create account
router.post('/register', telegramAuth, async (req, res, next) => {
  try {
    if (req.user) {
      return res.json({ success: true, data: { user: req.user, message: 'Account already exists.' } });
    }

    const { display_name, language } = req.body;
    if (!display_name || display_name.trim().length < 1) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Display name is required.' },
      });
    }

    const user = await userService.register({
      id: req.telegramUser.id,
      display_name: display_name.trim(),
      language: language || 'en',
    });

    res.status(201).json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
