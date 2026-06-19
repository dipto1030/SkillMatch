const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const db = require('../config/database');

// GET /api/games — List all active games
router.get('/', telegramAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM games WHERE is_active = TRUE ORDER BY name ASC'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/games/:id — Game detail + rule presets
router.get('/:id', telegramAuth, async (req, res, next) => {
  try {
    const { rows: gameRows } = await db.query('SELECT * FROM games WHERE id = $1', [req.params.id]);
    if (!gameRows[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Game not found.' } });
    }

    const { rows: presets } = await db.query(
      'SELECT * FROM rule_presets WHERE game_id = $1 ORDER BY sort_order ASC',
      [req.params.id]
    );

    res.json({ success: true, data: { game: gameRows[0], presets } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
