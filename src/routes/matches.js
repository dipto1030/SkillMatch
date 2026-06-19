const express = require('express');
const router = express.Router();
const { telegramAuth } = require('../middleware/auth');
const { rateLimiters } = require('../middleware/rateLimit');
const matchService = require('../services/matchService');

// POST /api/matches — Create match
router.post('/', telegramAuth, rateLimiters.createMatch, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { game_id, rule_preset_id, stake_per_player } = req.body;
    if (!game_id || !rule_preset_id || !stake_per_player) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'game_id, rule_preset_id, and stake_per_player are required.' } });
    }
    const match = await matchService.create(req.user.id, { game_id, rule_preset_id, stake_per_player });
    res.status(201).json({ success: true, data: match });
  } catch (err) {
    next(err);
  }
});

// GET /api/matches/open — Browse open matches
router.get('/open', telegramAuth, async (req, res, next) => {
  try {
    const { game_id, min_stake, max_stake, skill_tier, page, limit } = req.query;
    const matches = await matchService.browse({
      game_id: game_id ? parseInt(game_id) : null,
      min_stake: min_stake ? parseFloat(min_stake) : null,
      max_stake: max_stake ? parseFloat(max_stake) : null,
      skill_tier,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    });
    res.json({ success: true, data: matches });
  } catch (err) {
    next(err);
  }
});

// GET /api/matches/active — My current active match
router.get('/active', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { rows } = require('../config/database').query
      ? await require('../config/database').query(
        `SELECT * FROM matches WHERE (creator_id = $1 OR opponent_id = $1)
         AND status IN ('ACCEPTED', 'NEGOTIATING', 'LOCKED', 'ACTIVE', 'RESULT_PENDING')
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id]
      )
      : { rows: [] };
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/matches/history — My match history
router.get('/history', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    const db = require('../config/database');
    const { rows } = await db.query(
      `SELECT m.*, g.name as game_name FROM matches m
       JOIN games g ON g.id = m.game_id
       WHERE (m.creator_id = $1 OR m.opponent_id = $1)
       AND m.status IN ('COMPLETED', 'RESOLVED', 'CANCELLED')
       ORDER BY m.completed_at DESC NULLS LAST LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ success: true, data: { matches: rows, page, limit } });
  } catch (err) {
    next(err);
  }
});

// GET /api/matches/:id — Match detail
router.get('/:id', telegramAuth, async (req, res, next) => {
  try {
    const match = await matchService.getById(parseInt(req.params.id));
    if (!match) return res.status(404).json({ success: false, error: { code: 'MATCH_NOT_FOUND', message: 'Match not found.' } });
    res.json({ success: true, data: match });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/join — Join a match
router.post('/:id/join', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const match = await matchService.join(req.user.id, parseInt(req.params.id));
    res.json({ success: true, data: match });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/lock — Confirm escrow payment
router.post('/:id/lock', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const match = await matchService.lockEscrow(req.user.id, parseInt(req.params.id));
    res.json({ success: true, data: match });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/propose-rule — Propose custom rule
router.post('/:id/propose-rule', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { rule_text } = req.body;
    if (!rule_text) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'rule_text required.' } });
    const proposals = await matchService.proposeRule(req.user.id, parseInt(req.params.id), rule_text);
    res.json({ success: true, data: { proposals } });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/accept-rule — Accept a proposed rule
router.post('/:id/accept-rule', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { proposal_id } = req.body;
    const result = await matchService.respondToRule(req.user.id, parseInt(req.params.id), proposal_id, true);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/decline-rule — Decline a proposed rule
router.post('/:id/decline-rule', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { proposal_id } = req.body;
    const result = await matchService.respondToRule(req.user.id, parseInt(req.params.id), proposal_id, false);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/ready — Mark ready
router.post('/:id/ready', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const match = await matchService.markReady(req.user.id, parseInt(req.params.id));
    res.json({ success: true, data: match });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/submit-result — Submit match result
router.post('/:id/submit-result', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { result, confirmed } = req.body;
    if (!result) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'result is required.' } });
    const match = await matchService.submitResult(req.user.id, parseInt(req.params.id), result, confirmed);
    res.json({ success: true, data: match });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/:id/cancel — Cancel match
router.post('/:id/cancel', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const result = await matchService.cancel(req.user.id, parseInt(req.params.id));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/matches/reshuffle — Reshuffle
router.post('/reshuffle', telegramAuth, async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Not registered.' } });
    const { current_match_id } = req.body;
    const result = await matchService.reshuffle(req.user.id, current_match_id);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
