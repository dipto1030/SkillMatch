const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const { rateLimiters } = require('../middleware/rateLimit');
const db = require('../config/database');
const paymentService = require('../services/paymentService');

// GET /api/wallet — Balance breakdown
router.get('/', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    }
    const { rows } = await db.query(
      'SELECT available, locked, admin_hold FROM wallets WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ success: true, data: rows[0] || { available: 0, locked: 0, admin_hold: 0 } });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallet/deposit/create — Create Stars invoice
router.post('/deposit/create', telegramAuth, rateLimiters.createDeposit, async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    }
    const { token_amount } = req.body;
    if (!token_amount || token_amount <= 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid token amount required.' } });
    }
    const result = await paymentService.createDepositInvoice(req.user.id, token_amount);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/wallet/withdraw — Withdraw tokens to Stars
router.post('/withdraw', telegramAuth, rateLimiters.withdraw, async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    }
    const { token_amount } = req.body;
    if (!token_amount || token_amount <= 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid token amount required.' } });
    }
    const result = await paymentService.processWithdrawal(req.user.id, token_amount);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/wallet/history — Token ledger history (paginated)
router.get('/history', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    }
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const offset = (page - 1) * limit;

    const { rows } = await db.query(
      `SELECT * FROM token_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) as total FROM token_ledger WHERE user_id = $1',
      [req.user.id]
    );
    res.json({
      success: true,
      data: { transactions: rows, total: parseInt(countRows[0].total, 10), page, limit },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
