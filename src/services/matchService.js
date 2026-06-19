const db = require('../config/database');
const configService = require('./configService');
const { v4: uuidv4 } = require('uuid');

function generateMatchCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MATCH-';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

const matchService = {
  async create(userId, { game_id, rule_preset_id, stake_per_player }) {
    const maxStakePercent = configService.get('VAR_MAX_STAKE_PERCENT', 0.7);
    const minStake = configService.get('VAR_MIN_STAKE', 10);
    const newAccountPeriod = configService.get('VAR_NEW_ACCOUNT_PERIOD', 7);
    const newAccountStakeLimit = configService.get('VAR_NEW_ACCOUNT_STAKE_LIMIT', 100);

    return db.transaction(async (client) => {
      // Get wallet
      const { rows: walletRows } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (!walletRows[0]) throw Object.assign(new Error('Wallet not found.'), { status: 400, code: 'WALLET_NOT_FOUND' });

      const available = parseFloat(walletRows[0].available);
      const maxStake = Math.floor(available * maxStakePercent);

      if (stake_per_player < minStake) {
        throw Object.assign(new Error(`Minimum stake is ${minStake} Tokens.`), { status: 400, code: 'VALIDATION_ERROR' });
      }
      if (stake_per_player > maxStake) {
        throw Object.assign(new Error(`Maximum stake is ${maxStake} Tokens (70% of available balance).`), { status: 400, code: 'STAKE_EXCEEDS_MAX' });
      }

      // New account restriction
      const { rows: userRows } = await client.query('SELECT created_at FROM users WHERE id = $1', [userId]);
      const accountAgeDays = (Date.now() - new Date(userRows[0].created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (accountAgeDays < newAccountPeriod && stake_per_player > newAccountStakeLimit) {
        throw Object.assign(new Error(`New accounts are limited to ${newAccountStakeLimit} Token stakes for the first ${newAccountPeriod} days.`), { status: 400, code: 'STAKE_EXCEEDS_MAX' });
      }

      // Verify game and preset exist
      const { rows: gameRows } = await client.query('SELECT * FROM games WHERE id = $1 AND is_active = TRUE', [game_id]);
      if (!gameRows[0]) throw Object.assign(new Error('Game not found or inactive.'), { status: 400, code: 'VALIDATION_ERROR' });

      const { rows: presetRows } = await client.query('SELECT * FROM rule_presets WHERE id = $1 AND game_id = $2', [rule_preset_id, game_id]);
      if (!presetRows[0]) throw Object.assign(new Error('Invalid rule preset.'), { status: 400, code: 'VALIDATION_ERROR' });

      // Generate unique match code
      let matchCode;
      let codeExists = true;
      while (codeExists) {
        matchCode = generateMatchCode();
        const { rows: codeCheck } = await client.query('SELECT id FROM matches WHERE match_code = $1', [matchCode]);
        codeExists = codeCheck.length > 0;
      }

      const expiryHours = configService.get('VAR_OPEN_MATCH_EXPIRY', 24);

      const { rows: matchRows } = await client.query(
        `INSERT INTO matches (match_code, game_id, rule_preset_id, creator_id, stake_per_player, status, open_expiry)
         VALUES ($1, $2, $3, $4, $5, 'OPEN', NOW() + INTERVAL '${expiryHours} hours')
         RETURNING *`,
        [matchCode, game_id, rule_preset_id, userId, stake_per_player]
      );

      return matchRows[0];
    });
  },

  async browse({ game_id, min_stake, max_stake, skill_tier, page = 1, limit = 20 }) {
    const offset = (page - 1) * limit;
    let query = `SELECT m.*, g.name as game_name, g.icon_url, rp.label as rule_label,
                        u.display_name as creator_name, u.rep_score as creator_rep
                 FROM matches m
                 JOIN games g ON g.id = m.game_id
                 JOIN rule_presets rp ON rp.id = m.rule_preset_id
                 JOIN users u ON u.id = m.creator_id
                 WHERE m.status = 'OPEN'`;
    const params = [];
    let paramIdx = 1;

    if (game_id) {
      query += ` AND m.game_id = $${paramIdx++}`;
      params.push(game_id);
    }
    if (min_stake) {
      query += ` AND m.stake_per_player >= $${paramIdx++}`;
      params.push(min_stake);
    }
    if (max_stake) {
      query += ` AND m.stake_per_player <= $${paramIdx++}`;
      params.push(max_stake);
    }

    query += ` ORDER BY m.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const { rows } = await db.query(query, params);
    return rows;
  },

  async getById(matchId, client) {
    const queryFn = client || db;
    const { rows } = await queryFn.query(
      `SELECT m.*, g.name as game_name, g.icon_url, g.max_duration_min, g.draws_possible,
              rp.label as rule_label,
              uc.display_name as creator_name, uc.rep_score as creator_rep,
              uo.display_name as opponent_name, uo.rep_score as opponent_rep
       FROM matches m
       JOIN games g ON g.id = m.game_id
       JOIN rule_presets rp ON rp.id = m.rule_preset_id
       JOIN users uc ON uc.id = m.creator_id
       LEFT JOIN users uo ON uo.id = m.opponent_id
       WHERE m.id = $1`,
      [matchId]
    );
    return rows[0] || null;
  },

  async join(userId, matchId) {
    return db.transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM matches WHERE id = $1 FOR UPDATE',
        [matchId]
      );
      if (!rows[0]) throw Object.assign(new Error('Match not found.'), { status: 404, code: 'MATCH_NOT_FOUND' });
      const match = rows[0];

      if (match.status !== 'OPEN') {
        throw Object.assign(new Error('Match is not open for joining.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }
      if (match.creator_id === userId) {
        throw Object.assign(new Error('Cannot join your own match.'), { status: 400, code: 'VALIDATION_ERROR' });
      }

      // Check 70% rule for joiner
      const { rows: walletRows } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      const available = parseFloat(walletRows[0].available);
      const maxStakePercent = configService.get('VAR_MAX_STAKE_PERCENT', 0.7);
      if (match.stake_per_player > Math.floor(available * maxStakePercent)) {
        throw Object.assign(new Error('Insufficient balance for this stake.'), { status: 400, code: 'STAKE_EXCEEDS_MAX' });
      }

      const escrowWindow = configService.get('VAR_ESCROW_LOCK_WINDOW', 10);

      await client.query(
        `UPDATE matches SET opponent_id = $1, status = 'ACCEPTED',
         escrow_lock_deadline = NOW() + INTERVAL '${escrowWindow} minutes'
         WHERE id = $2`,
        [userId, matchId]
      );

      const updated = await this.getById(matchId, client);
      return updated;
    });
  },

  async lockEscrow(userId, matchId) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      if (!rows[0]) throw Object.assign(new Error('Match not found.'), { status: 404, code: 'MATCH_NOT_FOUND' });
      const match = rows[0];

      if (match.status !== 'ACCEPTED') {
        throw Object.assign(new Error('Match not in ACCEPTED state.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }
      if (match.creator_id !== userId && match.opponent_id !== userId) {
        throw Object.assign(new Error('Not a participant.'), { status: 403, code: 'MATCH_NOT_PARTICIPANT' });
      }

      const isCreator = match.creator_id === userId;
      const lockField = isCreator ? 'creator_escrow_locked' : 'opponent_escrow_locked';

      // Check if already locked
      const { rows: lockCheck } = await client.query(
        `SELECT ${lockField} FROM matches WHERE id = $1`,
        [matchId]
      );
      if (lockCheck[0][lockField]) {
        throw Object.assign(new Error('Escrow already locked.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }

      // Deduct from available, add to locked
      const stake = parseFloat(match.stake_per_player);
      const { rows: walletRows } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (parseFloat(walletRows[0].available) < stake) {
        throw Object.assign(new Error('Insufficient balance.'), { status: 400, code: 'INSUFFICIENT_BALANCE' });
      }

      await client.query(
        'UPDATE wallets SET available = available - $1, locked = locked + $1 WHERE user_id = $2',
        [stake, userId]
      );

      // Ledger entry
      const { rows: walletAfter } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [userId]);
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id)
         VALUES ($1, 'ESCROW_LOCK', $2, $3, $4)`,
        [userId, -stake, walletAfter[0].available, match.match_code]
      );

      // Mark lock
      await client.query(`UPDATE matches SET ${lockField} = TRUE WHERE id = $1`, [matchId]);

      // Check if both locked → move to NEGOTIATING
      const { rows: updatedMatch } = await client.query('SELECT * FROM matches WHERE id = $1', [matchId]);
      if (updatedMatch[0].creator_escrow_locked && updatedMatch[0].opponent_escrow_locked) {
        const negWindow = configService.get('VAR_RULE_NEGOTIATION_WINDOW', 5);
        await client.query(
          `UPDATE matches SET status = 'NEGOTIATING',
           negotiation_deadline = NOW() + INTERVAL '${negWindow} minutes'
           WHERE id = $1`,
          [matchId]
        );
      }

      return await this.getById(matchId, client);
    });
  },

  async proposeRule(userId, matchId, ruleText) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      if (!rows[0]) throw Object.assign(new Error('Match not found.'), { status: 404, code: 'MATCH_NOT_FOUND' });
      const match = rows[0];

      if (match.status !== 'NEGOTIATING') {
        throw Object.assign(new Error('Not in negotiation phase.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }

      const proposals = match.rule_proposals || [];
      proposals.push({
        id: uuidv4(),
        proposer_id: userId,
        text: ruleText,
        status: 'pending',
        proposed_at: new Date().toISOString(),
      });

      await client.query('UPDATE matches SET rule_proposals = $1 WHERE id = $2', [JSON.stringify(proposals), matchId]);
      return proposals;
    });
  },

  async respondToRule(userId, matchId, proposalId, accept) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      const match = rows[0];
      if (!match || match.status !== 'NEGOTIATING') {
        throw Object.assign(new Error('Not in negotiation phase.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }

      const proposals = match.rule_proposals || [];
      const proposal = proposals.find(p => p.id === proposalId);
      if (!proposal) throw Object.assign(new Error('Proposal not found.'), { status: 404 });
      if (proposal.proposer_id === userId) throw Object.assign(new Error('Cannot respond to own proposal.'), { status: 400 });
      if (proposal.status !== 'pending') throw Object.assign(new Error('Proposal already responded to.'), { status: 400, code: 'VALIDATION_ERROR' });

      proposal.status = accept ? 'accepted' : 'declined';
      proposal.responded_at = new Date().toISOString();

      // If accepted, add to custom_rules
      let customRules = match.custom_rules || [];
      if (accept) {
        customRules.push(proposal.text);
      }

      await client.query(
        'UPDATE matches SET rule_proposals = $1, custom_rules = $2 WHERE id = $3',
        [JSON.stringify(proposals), customRules, matchId]
      );

      return { proposals, custom_rules: customRules };
    });
  },

  async markReady(userId, matchId) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      const match = rows[0];
      if (!match || match.status !== 'NEGOTIATING') {
        throw Object.assign(new Error('Not in negotiation phase.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }

      const isCreator = match.creator_id === userId;
      const readyField = isCreator ? 'creator_ready' : 'opponent_ready';

      await client.query(`UPDATE matches SET ${readyField} = TRUE WHERE id = $1`, [matchId]);

      // Check if both ready
      const { rows: updated } = await client.query('SELECT * FROM matches WHERE id = $1', [matchId]);
      if (updated[0].creator_ready && updated[0].opponent_ready) {
        return this._activateMatch(client, matchId, match);
      }

      return await this.getById(matchId, client);
    });
  },

  async _activateMatch(client, matchId, match) {
    const { rows: gameRows } = await client.query('SELECT max_duration_min FROM games WHERE id = $1', [match.game_id]);
    const gameDuration = gameRows[0].max_duration_min;
    const resultWindow = configService.get('VAR_RESULT_SUBMISSION_WINDOW', 15);
    const totalMinutes = gameDuration + resultWindow;

    await client.query(
      `UPDATE matches SET status = 'ACTIVE', locked_at = NOW(),
       result_deadline = NOW() + INTERVAL '${totalMinutes} minutes'
       WHERE id = $1`,
      [matchId]
    );

    return await this.getById(matchId, client);
  },

  async submitResult(userId, matchId, result, confirmed) {
    if (!confirmed) {
      throw Object.assign(new Error('Result must be confirmed. Set confirmed: true.'), { status: 400, code: 'VALIDATION_ERROR' });
    }

    const validResults = ['WIN', 'LOSS', 'DRAW', 'RULE_VIOLATION_CLAIM'];
    if (!validResults.includes(result)) {
      throw Object.assign(new Error('Invalid result.'), { status: 400, code: 'VALIDATION_ERROR' });
    }

    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      if (!rows[0]) throw Object.assign(new Error('Match not found.'), { status: 404, code: 'MATCH_NOT_FOUND' });
      const match = rows[0];

      if (match.status !== 'ACTIVE' && match.status !== 'RESULT_PENDING') {
        throw Object.assign(new Error('Match is not active.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }

      const isCreator = match.creator_id === userId;
      if (!isCreator && match.opponent_id !== userId) {
        throw Object.assign(new Error('Not a participant.'), { status: 403, code: 'MATCH_NOT_PARTICIPANT' });
      }

      const resultField = isCreator ? 'creator_result' : 'opponent_result';
      if (match[resultField]) {
        throw Object.assign(new Error('Result already submitted.'), { status: 400, code: 'RESULT_ALREADY_SUBMITTED' });
      }

      await client.query(`UPDATE matches SET ${resultField} = $1, status = 'RESULT_PENDING' WHERE id = $2`, [result, matchId]);

      // Handle RULE_VIOLATION_CLAIM
      if (result === 'RULE_VIOLATION_CLAIM') {
        await client.query("UPDATE matches SET status = 'DISPUTED' WHERE id = $1", [matchId]);
        // Create dispute automatically
        const disputeService = require('./disputeService');
        await disputeService.createFromRuleViolation(client, match, userId);
        return await this.getById(matchId, client);
      }

      // Check if both submitted
      const { rows: updatedRows } = await client.query('SELECT * FROM matches WHERE id = $1', [matchId]);
      const updated = updatedRows[0];

      if (updated.creator_result && updated.opponent_result) {
        return this._resolveResults(client, updated);
      }

      return await this.getById(matchId, client);
    });
  },

  async _resolveResults(client, match) {
    const cr = match.creator_result;
    const or = match.opponent_result;
    const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
    const stake = parseFloat(match.stake_per_player);
    const pot = stake * 2;
    const fee = Math.round(pot * platformFee * 100) / 100;

    // Scenario A — Both agree on same winner
    if ((cr === 'WIN' && or === 'LOSS') || (cr === 'LOSS' && or === 'WIN')) {
      const winnerId = cr === 'WIN' ? match.creator_id : match.opponent_id;
      const loserId = cr === 'WIN' ? match.opponent_id : match.creator_id;
      return this._awardWinner(client, match, winnerId, loserId, pot, fee);
    }

    // Scenario E — Both claim opponent won (mutual forfeit)
    if (cr === 'LOSS' && or === 'LOSS') {
      return this._mutualForfeit(client, match, stake, platformFee);
    }

    // Scenario G — Both report Draw
    if (cr === 'DRAW' && or === 'DRAW') {
      const { rows: gameRows } = await client.query('SELECT draws_possible FROM games WHERE id = $1', [match.game_id]);
      if (!gameRows[0].draws_possible) {
        // Treated as conflict
        await client.query("UPDATE matches SET status = 'DISPUTED' WHERE id = $1", [match.id]);
        return await this.getById(match.id, client);
      }
      return this._drawResult(client, match, stake, platformFee);
    }

    // Scenario D/F — Conflicting results → DISPUTE
    await client.query("UPDATE matches SET status = 'DISPUTED' WHERE id = $1", [match.id]);
    return await this.getById(match.id, client);
  },

  async _awardWinner(client, match, winnerId, loserId, pot, fee) {
    const payout = pot - fee;

    // Winner: locked → available (minus fee)
    await client.query(
      'UPDATE wallets SET locked = locked - $1, available = available + $2 WHERE user_id = $3',
      [match.stake_per_player, payout, winnerId]
    );
    // Loser: locked reduced
    await client.query(
      'UPDATE wallets SET locked = locked - $1 WHERE user_id = $2',
      [match.stake_per_player, loserId]
    );

    // Ledger entries
    const { rows: winnerWallet } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [winnerId]);
    await client.query(
      `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'ESCROW_WIN', $2, $3, $4)`,
      [winnerId, payout, winnerWallet[0].available, match.match_code]
    );
    const { rows: loserWallet } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [loserId]);
    await client.query(
      `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'ESCROW_WIN', $2, $3, $4)`,
      [loserId, -parseFloat(match.stake_per_player), loserWallet[0].available, match.match_code]
    );
    // Platform fee ledger
    await client.query(
      `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'FEE', $2, 0, $3)`,
      [winnerId, -fee, match.match_code]
    );

    await client.query(
      `UPDATE matches SET status = 'COMPLETED', winner_id = $1, platform_fee = $2, completed_at = NOW() WHERE id = $3`,
      [winnerId, fee, match.id]
    );

    // Update skill scores
    const scoreService = require('./scoreService');
    await scoreService.updateScores(client, match.game_id, winnerId, loserId);

    return await this.getById(match.id, client);
  },

  async _mutualForfeit(client, match, stake, feePercent) {
    const feePerPlayer = Math.round(stake * feePercent * 100) / 100;
    const refundPerPlayer = stake - feePerPlayer;

    for (const playerId of [match.creator_id, match.opponent_id]) {
      await client.query(
        'UPDATE wallets SET locked = locked - $1, available = available + $2 WHERE user_id = $3',
        [stake, refundPerPlayer, playerId]
      );
      const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [playerId]);
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'ESCROW_REFUND', $2, $3, $4)`,
        [playerId, refundPerPlayer, w[0].available, match.match_code]
      );
    }

    await client.query(
      `UPDATE matches SET status = 'COMPLETED', platform_fee = $1, completed_at = NOW() WHERE id = $2`,
      [feePerPlayer * 2, match.id]
    );

    return await this.getById(match.id, client);
  },

  async _drawResult(client, match, stake, feePercent) {
    return this._mutualForfeit(client, match, stake, feePercent);
  },

  async cancel(userId, matchId) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      if (!rows[0]) throw Object.assign(new Error('Match not found.'), { status: 404, code: 'MATCH_NOT_FOUND' });
      const match = rows[0];

      if (match.creator_id !== userId && match.opponent_id !== userId) {
        throw Object.assign(new Error('Not a participant.'), { status: 403, code: 'MATCH_NOT_PARTICIPANT' });
      }

      // Creator cancels before anyone joins
      if (match.status === 'OPEN' && match.creator_id === userId) {
        await client.query("UPDATE matches SET status = 'CANCELLED', is_void = TRUE, void_reason = 'Creator cancelled' WHERE id = $1", [matchId]);
        return { cancelled: true, refund: 'no_escrow' };
      }

      // Cancel during negotiation (rule disagreement — free)
      if (match.status === 'NEGOTIATING') {
        // Refund both players
        const stake = parseFloat(match.stake_per_player);
        for (const pid of [match.creator_id, match.opponent_id]) {
          await client.query(
            'UPDATE wallets SET locked = locked - $1, available = available + $1 WHERE user_id = $2',
            [stake, pid]
          );
          const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [pid]);
          await client.query(
            `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'ESCROW_REFUND', $2, $3, $4)`,
            [pid, stake, w[0].available, match.match_code]
          );
        }
        await client.query(
          "UPDATE matches SET status = 'CANCELLED', is_void = TRUE, void_reason = 'Rule disagreement cancellation' WHERE id = $1",
          [matchId]
        );
        return { cancelled: true, refund: 'full_refund_both' };
      }

      // After escrow locked — cancelling player forfeits
      if (match.status === 'LOCKED' || match.status === 'ACTIVE') {
        const cancellerId = userId;
        const otherId = match.creator_id === userId ? match.opponent_id : match.creator_id;
        const stake = parseFloat(match.stake_per_player);
        const pot = stake * 2;
        const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
        const fee = Math.round(pot * platformFee * 100) / 100;

        await this._awardWinner(client, match, otherId, cancellerId, pot, fee);
        return { cancelled: true, refund: 'forfeit' };
      }

      throw Object.assign(new Error('Cannot cancel match in current state.'), { status: 400, code: 'MATCH_WRONG_STATE' });
    });
  },

  async reshuffle(userId, currentMatchId) {
    return db.transaction(async (client) => {
      const freeShuffles = configService.get('VAR_FREE_SHUFFLES_PER_DAY', 5);
      const shuffleFee = configService.get('VAR_EXTRA_SHUFFLE_FEE', 5);

      // Get user shuffle count
      const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const user = userRows[0];

      // Reset if new day (BD timezone)
      const now = new Date();
      const resetAt = user.shuffle_reset_at ? new Date(user.shuffle_reset_at) : null;
      let shuffleCount = user.shuffle_count_today || 0;

      if (!resetAt || now.toDateString() !== resetAt.toDateString()) {
        shuffleCount = 0;
        await client.query(
          'UPDATE users SET shuffle_count_today = 0, shuffle_reset_at = NOW() WHERE id = $1',
          [userId]
        );
      }

      // Check if fee needed
      if (shuffleCount >= freeShuffles) {
        const { rows: walletRows } = await client.query(
          'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
          [userId]
        );
        if (parseFloat(walletRows[0].available) < shuffleFee) {
          throw Object.assign(new Error('Insufficient balance for reshuffle fee.'), { status: 400, code: 'INSUFFICIENT_BALANCE' });
        }
        await client.query(
          'UPDATE wallets SET available = available - $1 WHERE user_id = $2',
          [shuffleFee, userId]
        );
        const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [userId]);
        await client.query(
          `INSERT INTO token_ledger (user_id, type, amount, balance_after, note) VALUES ($1, 'SHUFFLE_FEE', $2, $3, 'Paid reshuffle fee')`,
          [userId, -shuffleFee, w[0].available]
        );
      }

      // Increment count
      await client.query(
        'UPDATE users SET shuffle_count_today = shuffle_count_today + 1 WHERE id = $1',
        [userId]
      );

      // Find next open match (different from currentMatchId, not created by user)
      const { rows: matches } = await client.query(
        `SELECT m.* FROM matches m
         WHERE m.status = 'OPEN' AND m.id != $1 AND m.creator_id != $2
         ORDER BY RANDOM() LIMIT 1`,
        [currentMatchId || 0, userId]
      );

      return {
        next_match: matches[0] || null,
        shuffles_remaining: Math.max(0, freeShuffles - shuffleCount - 1),
        paid: shuffleCount >= freeShuffles,
      };
    });
  },
};

module.exports = matchService;
