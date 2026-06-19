const db = require('../config/database');
const configService = require('./configService');

const juryService = {
  async checkEligibility(userId) {
    const minAge = configService.get('VAR_MIN_JURY_AGE', 2);
    const minMatches = configService.get('VAR_MIN_JURY_MATCHES', 20);
    const maxDisputesLost = configService.get('VAR_MAX_JURY_DISPUTES_LOST', 2);
    const maxWarnings = configService.get('VAR_MAX_JURY_WARNINGS', 1);

    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user) return { eligible: false, reason: 'User not found.' };

    if (user.is_banned) return { eligible: false, reason: 'Account is banned.' };

    // Account age check (months)
    const ageMonths = (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (ageMonths < minAge) return { eligible: false, reason: `Account must be at least ${minAge} months old.` };

    // Match count
    const { rows: matchCount } = await db.query(
      `SELECT COUNT(*) as cnt FROM matches WHERE (creator_id = $1 OR opponent_id = $1) AND status IN ('COMPLETED', 'RESOLVED')`,
      [userId]
    );
    if (parseInt(matchCount[0].cnt) < minMatches) {
      return { eligible: false, reason: `Must have at least ${minMatches} completed matches.` };
    }

    // Disputes lost in last 3 months
    const { rows: disputesLost } = await db.query(
      `SELECT COUNT(*) as cnt FROM disputes d
       JOIN matches m ON m.id = d.match_id
       WHERE (m.creator_id = $1 OR m.opponent_id = $1)
       AND d.winner_id IS NOT NULL AND d.winner_id != $1
       AND d.resolved_at > NOW() - INTERVAL '3 months'`,
      [userId]
    );
    if (parseInt(disputesLost[0].cnt) > maxDisputesLost) {
      return { eligible: false, reason: `Too many disputes lost in the last 3 months.` };
    }

    // Active warnings
    if (user.warning_count > maxWarnings) {
      return { eligible: false, reason: `Too many active warnings.` };
    }

    return { eligible: true };
  },

  async purchaseBadge(userId) {
    const eligibility = await this.checkEligibility(userId);
    if (!eligibility.eligible) {
      throw Object.assign(new Error(eligibility.reason), { status: 400, code: 'JURY_NOT_ELIGIBLE' });
    }

    const badgeCost = configService.get('VAR_JURY_BADGE_COST', 200);

    return db.transaction(async (client) => {
      const { rows: userRows } = await client.query('SELECT is_jury FROM users WHERE id = $1', [userId]);
      if (userRows[0].is_jury) {
        throw Object.assign(new Error('Already a juror.'), { status: 400 });
      }

      const { rows: walletRows } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (parseFloat(walletRows[0].available) < badgeCost) {
        throw Object.assign(new Error('Insufficient balance for jury badge.'), { status: 400, code: 'INSUFFICIENT_BALANCE' });
      }

      await client.query('UPDATE wallets SET available = available - $1 WHERE user_id = $2', [badgeCost, userId]);
      const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [userId]);
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, note) VALUES ($1, 'FEE', $2, $3, 'Jury badge purchase')`,
        [userId, -badgeCost, w[0].available]
      );

      await client.query('UPDATE users SET is_jury = TRUE, jury_active = TRUE WHERE id = $1', [userId]);

      return { purchased: true, cost: badgeCost };
    });
  },

  async assignCase(disputeId) {
    return db.transaction(async (client) => {
      const { rows: disputeRows } = await client.query('SELECT * FROM disputes WHERE id = $1', [disputeId]);
      const dispute = disputeRows[0];

      const { rows: matchRows } = await client.query('SELECT * FROM matches WHERE id = $1', [dispute.match_id]);
      const match = matchRows[0];

      // Determine jury size based on pot
      const pot = parseFloat(match.stake_per_player) * 2;
      const tierM = configService.get('VAR_STAKE_TIER_M', 500);
      const tierL = configService.get('VAR_STAKE_TIER_L', 2000);
      let jurySize;
      if (pot < tierM) jurySize = configService.get('VAR_JURY_SIZE_S', 3);
      else if (pot <= tierL) jurySize = configService.get('VAR_JURY_SIZE_M', 5);
      else jurySize = configService.get('VAR_JURY_SIZE_L', 7);

      const votesNeeded = jurySize === 3 ? 3 : jurySize === 5 ? 4 : 5;

      // Find eligible jurors (not participants, active, not banned)
      const { rows: jurors } = await client.query(
        `SELECT id FROM users
         WHERE is_jury = TRUE AND jury_active = TRUE AND is_banned = FALSE
         AND id NOT IN ($1, $2)
         ORDER BY RANDOM() LIMIT $3`,
        [match.creator_id, match.opponent_id, jurySize]
      );

      if (jurors.length < jurySize) {
        // Not enough jurors — escalate to admin
        await client.query("UPDATE disputes SET status = 'ESCALATED' WHERE id = $1", [disputeId]);
        await client.query("UPDATE matches SET status = 'FAST_TRACK' WHERE id = $1", [match.id]);
        return { escalated: true, reason: 'Insufficient jurors available.' };
      }

      const juryWindow = configService.get('VAR_JURY_WINDOW', 48);

      // Randomize alpha/beta assignment
      const alphaId = Math.random() > 0.5 ? match.creator_id : match.opponent_id;
      const betaId = alphaId === match.creator_id ? match.opponent_id : match.creator_id;

      const { rows: caseRows } = await client.query(
        `INSERT INTO jury_cases (dispute_id, alpha_id, beta_id, jury_size, votes_needed, deadline)
         VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '${juryWindow} hours')
         RETURNING *`,
        [disputeId, alphaId, betaId, jurySize, votesNeeded]
      );

      // Assign jurors
      for (const juror of jurors) {
        await client.query(
          'INSERT INTO jury_assignments (case_id, juror_id) VALUES ($1, $2)',
          [caseRows[0].id, juror.id]
        );
      }

      await client.query("UPDATE disputes SET status = 'JURY_ASSIGNED' WHERE id = $1", [disputeId]);
      await client.query("UPDATE matches SET status = 'JURY_REVIEW' WHERE id = $1", [match.id]);

      return { case_id: caseRows[0].id, jury_size: jurySize };
    });
  },

  async submitVote(jurorId, caseId, vote, explanation) {
    if (!['ALPHA', 'BETA'].includes(vote)) {
      throw Object.assign(new Error('Vote must be ALPHA or BETA.'), { status: 400 });
    }
    if (!explanation || explanation.trim().length === 0) {
      throw Object.assign(new Error('Explanation is required.'), { status: 400 });
    }
    if (explanation.split(/\s+/).length > 15) {
      throw Object.assign(new Error('Explanation must be max 15 words.'), { status: 400 });
    }

    return db.transaction(async (client) => {
      const { rows: assignment } = await client.query(
        'SELECT * FROM jury_assignments WHERE case_id = $1 AND juror_id = $2 FOR UPDATE',
        [caseId, jurorId]
      );
      if (!assignment[0]) throw Object.assign(new Error('Not assigned to this case.'), { status: 403 });
      if (assignment[0].vote) throw Object.assign(new Error('Already voted.'), { status: 400 });

      await client.query(
        'UPDATE jury_assignments SET vote = $1, explanation = $2, voted_at = NOW() WHERE id = $3',
        [vote, explanation.trim(), assignment[0].id]
      );

      // Check if all votes are in or quorum reached
      const { rows: caseRows } = await client.query('SELECT * FROM jury_cases WHERE id = $1 FOR UPDATE', [caseId]);
      const juryCase = caseRows[0];

      const { rows: votes } = await client.query(
        'SELECT vote FROM jury_assignments WHERE case_id = $1 AND vote IS NOT NULL',
        [caseId]
      );

      const alphaVotes = votes.filter(v => v.vote === 'ALPHA').length;
      const betaVotes = votes.filter(v => v.vote === 'BETA').length;
      const totalVotes = votes.length;

      // Check majority notification (>50% voted)
      if (totalVotes > juryCase.jury_size / 2) {
        // Send notification to both players (without revealing tally)
      }

      // Check if quorum reached
      if (totalVotes >= juryCase.votes_needed) {
        const verdict = alphaVotes > betaVotes ? 'ALPHA' : 'BETA';
        await client.query(
          "UPDATE jury_cases SET status = 'DECIDED', verdict = $1 WHERE id = $2",
          [verdict, caseId]
        );

        // Distribute rewards and resolve
        await this._resolveJuryVerdict(client, juryCase, verdict, votes);
      }

      return { voted: true };
    });
  },

  async _resolveJuryVerdict(client, juryCase, verdict, votes) {
    const { rows: disputeRows } = await client.query('SELECT * FROM disputes WHERE id = $1', [juryCase.dispute_id]);
    const dispute = disputeRows[0];

    const winnerId = verdict === 'ALPHA' ? juryCase.alpha_id : juryCase.beta_id;
    const loserId = verdict === 'ALPHA' ? juryCase.beta_id : juryCase.alpha_id;

    // Resolve the dispute
    const { rows: matchRows } = await client.query('SELECT * FROM matches WHERE id = $1', [dispute.match_id]);
    const match = matchRows[0];
    const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
    const pot = parseFloat(match.stake_per_player) * 2;
    const fee = Math.round(pot * platformFee * 100) / 100;
    const payout = pot - fee;

    // Winner gets pot + dispute stake back + loser's dispute stake
    const disputeStake = parseFloat(dispute.required_stake);
    const juryRewardPercent = configService.get('VAR_JURY_REWARD_PERCENT', 0.3);
    const adminCut = configService.get('VAR_ADMIN_DISPUTE_CUT', 0.2);
    const combinedStakes = disputeStake * 2;
    const juryPool = Math.round(combinedStakes * juryRewardPercent * 100) / 100;
    const adminPool = Math.round(combinedStakes * adminCut * 100) / 100;
    const winnerBonus = combinedStakes - juryPool - adminPool;

    // Credit winner
    await client.query(
      'UPDATE wallets SET locked = locked - $1, available = available + $2 WHERE user_id = $3',
      [match.stake_per_player, payout + disputeStake + winnerBonus, winnerId]
    );

    // Debit loser escrow
    await client.query(
      'UPDATE wallets SET locked = locked - $1 WHERE user_id = $2',
      [match.stake_per_player, loserId]
    );

    // Reward jurors who voted with majority
    const { rows: jurorVotes } = await client.query(
      'SELECT * FROM jury_assignments WHERE case_id = $1',
      [juryCase.id]
    );

    const majorityVoters = jurorVotes.filter(v => v.vote === verdict);
    if (majorityVoters.length > 0) {
      const rewardEach = Math.round((juryPool / majorityVoters.length) * 100) / 100;
      for (const juror of majorityVoters) {
        await client.query(
          'UPDATE wallets SET available = available + $1 WHERE user_id = $2',
          [rewardEach, juror.juror_id]
        );
        await client.query(
          'UPDATE jury_assignments SET reward_paid = $1 WHERE id = $2',
          [rewardEach, juror.id]
        );
        const { rows: jw } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [juror.juror_id]);
        await client.query(
          `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'JURY_REWARD', $2, $3, $4)`,
          [juror.juror_id, rewardEach, jw[0].available, `case_${juryCase.id}`]
        );
      }
    }

    await client.query(
      "UPDATE disputes SET status = 'RESOLVED', winner_id = $1, resolved_at = NOW() WHERE id = $2",
      [winnerId, dispute.id]
    );
    await client.query(
      "UPDATE matches SET status = 'RESOLVED', winner_id = $1, platform_fee = $2, completed_at = NOW() WHERE id = $3",
      [winnerId, fee, match.id]
    );

    // Loser gets warning
    await client.query(
      `INSERT INTO warnings (user_id, reason, issued_by, expires_at)
       VALUES ($1, 'Lost dispute', 'system', NOW() + INTERVAL '${configService.get('VAR_WARNING_EXPIRY', 30)} days')`,
      [loserId]
    );
    await client.query('UPDATE users SET warning_count = warning_count + 1 WHERE id = $1', [loserId]);
  },

  async getCase(caseId) {
    const { rows: caseRows } = await db.query('SELECT * FROM jury_cases WHERE id = $1', [caseId]);
    if (!caseRows[0]) return null;

    const { rows: evidence } = await db.query(
      `SELECT de.* FROM dispute_evidence de WHERE de.dispute_id = $1`,
      [caseRows[0].dispute_id]
    );

    const { rows: matchRows } = await db.query(
      `SELECT m.game_id, g.name as game_name, m.stake_per_player, m.custom_rules, m.lobby_chat_log,
              rp.label as rule_label
       FROM matches m
       JOIN disputes d ON d.match_id = m.id
       JOIN games g ON g.id = m.game_id
       JOIN rule_presets rp ON rp.id = m.rule_preset_id
       WHERE d.id = $1`,
      [caseRows[0].dispute_id]
    );

    return {
      ...caseRows[0],
      evidence: evidence.map(e => ({
        ...e,
        user_id: e.user_id === caseRows[0].alpha_id ? 'ALPHA' : 'BETA',
      })),
      match_info: matchRows[0] || null,
    };
  },

  async getMyCases(jurorId) {
    const { rows } = await db.query(
      `SELECT jc.*, ja.vote, ja.voted_at
       FROM jury_cases jc
       JOIN jury_assignments ja ON ja.case_id = jc.id
       WHERE ja.juror_id = $1
       ORDER BY jc.created_at DESC`,
      [jurorId]
    );
    return rows;
  },

  async skipCase(jurorId, caseId) {
    const maxSkips = configService.get('VAR_JURY_SKIPS_PER_MONTH', 2);
    const { rows: skips } = await db.query(
      `SELECT COUNT(*) as cnt FROM jury_skips
       WHERE juror_id = $1 AND skipped_at > NOW() - INTERVAL '30 days'`,
      [jurorId]
    );
    if (parseInt(skips[0].cnt) >= maxSkips) {
      throw Object.assign(new Error('Monthly skip limit reached.'), { status: 400 });
    }

    await db.transaction(async (client) => {
      await client.query('DELETE FROM jury_assignments WHERE case_id = $1 AND juror_id = $2', [caseId, jurorId]);
      await client.query(
        'INSERT INTO jury_skips (juror_id, case_id) VALUES ($1, $2)',
        [jurorId, caseId]
      );
    });

    return { skipped: true };
  },

  async reactivateBadge(userId) {
    await db.query('UPDATE users SET jury_active = TRUE, jury_strikes = 0 WHERE id = $1', [userId]);
    return { reactivated: true };
  },
};

module.exports = juryService;
