const express = require('express');
const router = express.Router();
const { adminAuth } = require('../middleware/adminAuth');
const { rateLimiters } = require('../middleware/rateLimit');
const db = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const configService = require('../services/configService');

// POST /api/admin/login — Admin login
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const { rows } = await db.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    if (!rows[0]) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Invalid credentials.' } });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ success: false, error: { code: 'AUTH_INVALID', message: 'Invalid credentials.' } });

    const token = jwt.sign({ adminId: rows[0].id, isAdmin: true }, env.ADMIN_JWT_SECRET, { expiresIn: env.ADMIN_JWT_EXPIRY });
    res.json({ success: true, data: { token, admin: { id: rows[0].id, username: rows[0].username } } });
  } catch (err) {
    next(err);
  }
});

// All following routes require admin auth
router.use(adminAuth);
router.use(rateLimiters.adminEndpoint);

// GET /api/admin/users — List/search users
router.get('/users', async (req, res, next) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = 'SELECT * FROM users WHERE 1=1';
    const params = [];
    let idx = 1;

    if (search) {
      query += ` AND (display_name ILIKE $${idx} OR id::text = $${idx + 1})`;
      params.push(`%${search}%`, search);
      idx += 2;
    }
    if (status === 'banned') { query += ' AND is_banned = TRUE'; }
    if (status === 'frozen') { query += ' AND is_frozen = TRUE'; }

    query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), offset);

    const { rows } = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/users/:id — Full user profile
router.get('/users/:id', async (req, res, next) => {
  try {
    const { rows: user } = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found.' } });
    const { rows: wallet } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.params.id]);
    const { rows: warnings } = await db.query('SELECT * FROM warnings WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ success: true, data: { user: user[0], wallet: wallet[0], warnings } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/warn — Issue warning
router.post('/users/:id/warn', async (req, res, next) => {
  try {
    const { reason } = req.body;
    const warningExpiry = configService.get('VAR_WARNING_EXPIRY', 30);

    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO warnings (user_id, reason, issued_by, expires_at) VALUES ($1, $2, 'admin', NOW() + INTERVAL '${warningExpiry} days')`,
        [req.params.id, reason]
      );
      await client.query('UPDATE users SET warning_count = warning_count + 1 WHERE id = $1', [req.params.id]);
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'WARN', 'user', $2, $3)`,
        [req.adminId, req.params.id, JSON.stringify({ reason })]
      );
    });

    const bot = require('../bot');
    await bot.sendNotification(parseInt(req.params.id), `⚠️ You have received a warning: ${reason}`);
    res.json({ success: true, data: { warned: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/ban — Apply ban
router.post('/users/:id/ban', async (req, res, next) => {
  try {
    const { ban_type, duration_days, reason } = req.body;

    await db.transaction(async (client) => {
      if (ban_type === 'permanent') {
        await client.query(
          "UPDATE users SET is_banned = TRUE, ban_type = 'permanent' WHERE id = $1",
          [req.params.id]
        );
        // Seize wallet
        const { rows: wallet } = await client.query('SELECT available, locked FROM wallets WHERE user_id = $1', [req.params.id]);
        if (wallet[0]) {
          const seized = parseFloat(wallet[0].available) + parseFloat(wallet[0].locked);
          await client.query('UPDATE wallets SET available = 0, locked = 0, admin_hold = 0 WHERE user_id = $1', [req.params.id]);
          await client.query(
            `INSERT INTO token_ledger (user_id, type, amount, balance_after, note) VALUES ($1, 'SEIZURE', $2, 0, $3)`,
            [req.params.id, -seized, reason || 'Permanent ban — wallet seized']
          );
        }
      } else {
        await client.query(
          "UPDATE users SET is_banned = TRUE, ban_type = 'temp', ban_until = NOW() + INTERVAL '$1 days' WHERE id = $2",
          [duration_days || 7, req.params.id]
        );
      }

      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'BAN', 'user', $2, $3)`,
        [req.adminId, req.params.id, JSON.stringify({ ban_type, duration_days, reason })]
      );
    });

    res.json({ success: true, data: { banned: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/unban — Lift ban
router.post('/users/:id/unban', async (req, res, next) => {
  try {
    await db.transaction(async (client) => {
      await client.query("UPDATE users SET is_banned = FALSE, ban_type = NULL, ban_until = NULL WHERE id = $1", [req.params.id]);
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'UNBAN', 'user', $2, '{}')`,
        [req.adminId, req.params.id]
      );
    });
    res.json({ success: true, data: { unbanned: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/freeze — Freeze account
router.post('/users/:id/freeze', async (req, res, next) => {
  try {
    await db.transaction(async (client) => {
      await client.query('UPDATE users SET is_frozen = TRUE WHERE id = $1', [req.params.id]);
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'FREEZE', 'user', $2, '{}')`,
        [req.adminId, req.params.id]
      );
    });
    res.json({ success: true, data: { frozen: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/users/:id/unfreeze — Unfreeze account
router.post('/users/:id/unfreeze', async (req, res, next) => {
  try {
    await db.transaction(async (client) => {
      await client.query('UPDATE users SET is_frozen = FALSE WHERE id = $1', [req.params.id]);
      // Reset consecutive report counter
      await client.query('UPDATE player_reports SET is_consecutive = FALSE WHERE reported_id = $1', [req.params.id]);
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'UNFREEZE', 'user', $2, '{}')`,
        [req.adminId, req.params.id]
      );
    });
    res.json({ success: true, data: { unfrozen: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/wallet/credit — Credit Tokens to wallet
router.post('/wallet/credit', async (req, res, next) => {
  try {
    const { user_id, amount, reason } = req.body;
    await db.transaction(async (client) => {
      await client.query('UPDATE wallets SET available = available + $1 WHERE user_id = $2', [amount, user_id]);
      const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [user_id]);
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, note) VALUES ($1, 'ADMIN_CREDIT', $2, $3, $4)`,
        [user_id, amount, w[0].available, reason]
      );
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'WALLET_CREDIT', 'wallet', $2, $3)`,
        [req.adminId, user_id, JSON.stringify({ amount, reason })]
      );
    });
    res.json({ success: true, data: { credited: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/wallet/deduct — Deduct Tokens from wallet
router.post('/wallet/deduct', async (req, res, next) => {
  try {
    const { user_id, amount, reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Reason is required.' } });

    await db.transaction(async (client) => {
      const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE', [user_id]);
      const deductAmount = Math.min(amount, parseFloat(w[0].available));
      await client.query('UPDATE wallets SET available = GREATEST(0, available - $1) WHERE user_id = $2', [amount, user_id]);
      const { rows: after } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [user_id]);
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, note) VALUES ($1, 'ADMIN_DEDUCT', $2, $3, $4)`,
        [user_id, -deductAmount, after[0].available, reason]
      );
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'WALLET_DEDUCT', 'wallet', $2, $3)`,
        [req.adminId, user_id, JSON.stringify({ amount, reason })]
      );
    });
    res.json({ success: true, data: { deducted: true } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/wallet/:userId — Full wallet detail
router.get('/wallet/:userId', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.params.userId]);
    res.json({ success: true, data: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/matches — All matches
router.get('/matches', async (req, res, next) => {
  try {
    const { status, game_id, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let query = 'SELECT m.*, g.name as game_name FROM matches m JOIN games g ON g.id = m.game_id WHERE 1=1';
    const params = [];
    let idx = 1;
    if (status) { query += ` AND m.status = $${idx++}`; params.push(status); }
    if (game_id) { query += ` AND m.game_id = $${idx++}`; params.push(game_id); }
    query += ` ORDER BY m.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), offset);
    const { rows } = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/matches/:id/void — Void a match
router.post('/matches/:id/void', async (req, res, next) => {
  try {
    const matchId = parseInt(req.params.id);
    await db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      const match = rows[0];
      if (!match) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });

      // Refund both players
      const stake = parseFloat(match.stake_per_player);
      for (const pid of [match.creator_id, match.opponent_id].filter(Boolean)) {
        await client.query('UPDATE wallets SET locked = GREATEST(0, locked - $1), available = available + $1 WHERE user_id = $2', [stake, pid]);
        const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [pid]);
        await client.query(
          `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'ESCROW_REFUND', $2, $3, $4)`,
          [pid, stake, w[0].available, match.match_code]
        );
      }

      await client.query(
        "UPDATE matches SET status = 'CANCELLED', is_void = TRUE, void_reason = $1 WHERE id = $2",
        [req.body.reason || 'Voided by admin', matchId]
      );
      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'VOID_MATCH', 'match', $2, $3)`,
        [req.adminId, matchId, JSON.stringify({ reason: req.body.reason })]
      );
    });
    res.json({ success: true, data: { voided: true } });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/disputes/:id/resolve — Resolve dispute
router.post('/disputes/:id/resolve', async (req, res, next) => {
  try {
    const { winner, notes } = req.body; // 'creator' | 'opponent' | 'void'
    const disputeId = parseInt(req.params.id);

    await db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
      const dispute = rows[0];
      const { rows: matchRows } = await client.query('SELECT * FROM matches WHERE id = $1', [dispute.match_id]);
      const match = matchRows[0];

      let winnerId = null;
      if (winner === 'creator') winnerId = match.creator_id;
      else if (winner === 'opponent') winnerId = match.opponent_id;

      await client.query(
        "UPDATE disputes SET status = 'RESOLVED', winner_id = $1, admin_notes = $2, resolved_at = NOW() WHERE id = $3",
        [winnerId, notes, disputeId]
      );

      if (winnerId) {
        const matchService = require('../services/matchService');
        const loserId = winnerId === match.creator_id ? match.opponent_id : match.creator_id;
        const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
        const pot = parseFloat(match.stake_per_player) * 2;
        const fee = Math.round(pot * platformFee * 100) / 100;
        await matchService._awardWinner(client, match, winnerId, loserId, pot, fee);
      }

      await client.query(
        "UPDATE matches SET status = 'RESOLVED', completed_at = NOW() WHERE id = $1",
        [match.id]
      );

      await client.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'RESOLVE_DISPUTE', 'dispute', $2, $3)`,
        [req.adminId, disputeId, JSON.stringify({ winner, notes })]
      );
    });
    res.json({ success: true, data: { resolved: true } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/disputes — All open disputes
router.get('/disputes', async (req, res, next) => {
  try {
    const { status, track } = req.query;
    let query = 'SELECT d.*, m.match_code, m.stake_per_player FROM disputes d JOIN matches m ON m.id = d.match_id WHERE 1=1';
    const params = [];
    let idx = 1;
    if (status) { query += ` AND d.status = $${idx++}`; params.push(status); }
    if (track) { query += ` AND d.track = $${idx++}`; params.push(track); }
    query += ' ORDER BY d.created_at DESC';
    const { rows } = await db.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Game library CRUD
router.get('/games', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM games ORDER BY created_at DESC');
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/games', async (req, res, next) => {
  try {
    const { name, icon_url, match_types, platforms, max_duration_min, draws_possible, evidence_type } = req.body;
    const { rows } = await db.query(
      `INSERT INTO games (name, icon_url, match_types, platforms, max_duration_min, draws_possible, evidence_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, icon_url, match_types || ['1v1'], platforms || ['android'], max_duration_min, draws_possible || false, evidence_type || 'screenshot']
    );
    await db.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'ADD_GAME', 'game', $2, $3)`,
      [req.adminId, rows[0].id, JSON.stringify({ name })]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.put('/games/:id', async (req, res, next) => {
  try {
    const { name, icon_url, match_types, platforms, max_duration_min, draws_possible, evidence_type } = req.body;
    const { rows } = await db.query(
      `UPDATE games SET name = COALESCE($1, name), icon_url = COALESCE($2, icon_url),
       match_types = COALESCE($3, match_types), platforms = COALESCE($4, platforms),
       max_duration_min = COALESCE($5, max_duration_min), draws_possible = COALESCE($6, draws_possible),
       evidence_type = COALESCE($7, evidence_type) WHERE id = $8 RETURNING *`,
      [name, icon_url, match_types, platforms, max_duration_min, draws_possible, evidence_type, req.params.id]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// Jury management
router.get('/jury/pool', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, display_name, is_jury, jury_active, jury_strikes, created_at FROM users WHERE is_jury = TRUE'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/jury/assign', async (req, res, next) => {
  try {
    const { user_id } = req.body;
    await db.query('UPDATE users SET is_jury = TRUE, jury_active = TRUE WHERE id = $1', [user_id]);
    await db.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'ASSIGN_JURY', 'user', $2, '{}')`,
      [req.adminId, user_id]
    );
    res.json({ success: true, data: { assigned: true } });
  } catch (err) {
    next(err);
  }
});

router.post('/jury/revoke', async (req, res, next) => {
  try {
    const { user_id } = req.body;
    await db.query('UPDATE users SET is_jury = FALSE, jury_active = FALSE WHERE id = $1', [user_id]);
    await db.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, payload) VALUES ($1, 'REVOKE_JURY', 'user', $2, '{}')`,
      [req.adminId, user_id]
    );
    res.json({ success: true, data: { revoked: true } });
  } catch (err) {
    next(err);
  }
});

// Reports
router.get('/reports', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT pr.*, u.display_name as reporter_name, ur.display_name as reported_name
       FROM player_reports pr
       JOIN users u ON u.id = pr.reporter_id
       JOIN users ur ON ur.id = pr.reported_id
       ORDER BY pr.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Audit log
router.get('/audit-log', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = (page - 1) * limit;
    const { rows } = await db.query('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// Platform stats
router.get('/stats', async (req, res, next) => {
  try {
    const { rows: userCount } = await db.query('SELECT COUNT(*) as cnt FROM users');
    const { rows: matchCount } = await db.query("SELECT COUNT(*) as cnt FROM matches WHERE status IN ('COMPLETED', 'RESOLVED')");
    const { rows: activeMatches } = await db.query("SELECT COUNT(*) as cnt FROM matches WHERE status IN ('ACTIVE', 'RESULT_PENDING')");
    const { rows: openDisputes } = await db.query("SELECT COUNT(*) as cnt FROM disputes WHERE status NOT IN ('RESOLVED', 'RESOLVED_DEFAULT')");
    const { rows: revenue } = await db.query("SELECT COALESCE(SUM(platform_fee), 0) as total FROM matches WHERE completed_at > NOW() - INTERVAL '24 hours'");
    res.json({
      success: true,
      data: {
        total_users: parseInt(userCount[0].cnt),
        completed_matches: parseInt(matchCount[0].cnt),
        active_matches: parseInt(activeMatches[0].cnt),
        open_disputes: parseInt(openDisputes[0].cnt),
        revenue_24h: parseFloat(revenue[0].total),
      },
    });
  } catch (err) {
    next(err);
  }
});

// Config management
router.get('/config', async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT * FROM platform_config ORDER BY key');
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
});

router.put('/config/:key', async (req, res, next) => {
  try {
    const { value } = req.body;
    await configService.set(req.params.key, value, req.adminId);
    res.json({ success: true, data: { updated: true } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
