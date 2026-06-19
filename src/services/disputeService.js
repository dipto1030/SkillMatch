const db = require('../config/database');
const configService = require('./configService');

const disputeService = {
  calculateDisputeStake(perPlayerStake) {
    const minStake = configService.get('VAR_DISPUTE_STAKE_MIN', 50);
    const percent = configService.get('VAR_DISPUTE_STAKE_PERCENT', 0.35);
    return Math.max(minStake, Math.round(perPlayerStake * percent));
  },

  async create(userId, matchId) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM matches WHERE id = $1 FOR UPDATE', [matchId]);
      if (!rows[0]) throw Object.assign(new Error('Match not found.'), { status: 404, code: 'MATCH_NOT_FOUND' });
      const match = rows[0];

      if (match.status !== 'DISPUTED') {
        throw Object.assign(new Error('Match is not in DISPUTED state.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }

      // Check if dispute already exists
      const { rows: existingDispute } = await client.query(
        'SELECT id FROM disputes WHERE match_id = $1',
        [matchId]
      );
      if (existingDispute.length > 0) {
        throw Object.assign(new Error('Dispute already exists.'), { status: 400, code: 'DISPUTE_ALREADY_OPEN' });
      }

      const disputeStake = this.calculateDisputeStake(parseFloat(match.stake_per_player));
      const stakeWindow = configService.get('VAR_DISPUTE_STAKE_WINDOW', 60);

      const { rows: disputeRows } = await client.query(
        `INSERT INTO disputes (match_id, required_stake, status, stake_deadline)
         VALUES ($1, $2, 'PENDING_STAKE', NOW() + INTERVAL '${stakeWindow} minutes')
         RETURNING *`,
        [matchId, disputeStake]
      );

      return disputeRows[0];
    });
  },

  async createFromRuleViolation(client, match, claimantId) {
    const disputeStake = this.calculateDisputeStake(parseFloat(match.stake_per_player));
    const evidenceWindow = configService.get('VAR_EVIDENCE_WINDOW', 24);

    await client.query(
      `INSERT INTO disputes (match_id, required_stake, status, rule_violation_claimant_id, evidence_deadline)
       VALUES ($1, $2, 'PENDING_EVIDENCE', $3, NOW() + INTERVAL '${evidenceWindow} hours')`,
      [match.id, disputeStake, claimantId]
    );
  },

  async payStake(userId, disputeId) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
      if (!rows[0]) throw Object.assign(new Error('Dispute not found.'), { status: 404 });
      const dispute = rows[0];

      if (dispute.status !== 'PENDING_STAKE') {
        throw Object.assign(new Error('Not in stake payment phase.'), { status: 400, code: 'MATCH_WRONG_STATE' });
      }

      const { rows: matchRows } = await client.query('SELECT * FROM matches WHERE id = $1', [dispute.match_id]);
      const match = matchRows[0];

      if (match.creator_id !== userId && match.opponent_id !== userId) {
        throw Object.assign(new Error('Not a participant.'), { status: 403, code: 'MATCH_NOT_PARTICIPANT' });
      }

      const stake = parseFloat(dispute.required_stake);
      const isCreator = match.creator_id === userId;

      // Check if already paid
      const stakeField = isCreator ? 'creator_stake' : 'opponent_stake';
      if (dispute[stakeField]) {
        throw Object.assign(new Error('Stake already paid.'), { status: 400 });
      }

      // Check balance
      const { rows: walletRows } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (parseFloat(walletRows[0].available) < stake) {
        throw Object.assign(new Error(`Insufficient balance. You need ${stake} Tokens.`), { status: 400, code: 'INSUFFICIENT_BALANCE' });
      }

      // Deduct
      await client.query('UPDATE wallets SET available = available - $1 WHERE user_id = $2', [stake, userId]);
      const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [userId]);
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'DISPUTE_STAKE', $2, $3, $4)`,
        [userId, -stake, w[0].available, `dispute_${disputeId}`]
      );

      await client.query(`UPDATE disputes SET ${stakeField} = $1 WHERE id = $2`, [stake, disputeId]);

      // Check if both paid
      const { rows: updatedDispute } = await client.query('SELECT * FROM disputes WHERE id = $1', [disputeId]);
      if (updatedDispute[0].creator_stake && updatedDispute[0].opponent_stake) {
        const evidenceWindow = configService.get('VAR_EVIDENCE_WINDOW', 24);
        await client.query(
          `UPDATE disputes SET status = 'PENDING_EVIDENCE',
           evidence_deadline = NOW() + INTERVAL '${evidenceWindow} hours'
           WHERE id = $1`,
          [disputeId]
        );
      }

      return updatedDispute[0];
    });
  },

  async selectTrack(userId, disputeId, track) {
    if (!['standard', 'fast_track'].includes(track)) {
      throw Object.assign(new Error('Invalid track.'), { status: 400, code: 'VALIDATION_ERROR' });
    }

    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
      const dispute = rows[0];
      if (!dispute) throw Object.assign(new Error('Dispute not found.'), { status: 404 });

      if (track === 'fast_track') {
        const fastTrackFee = configService.get('VAR_FAST_DISPUTE_FEE', 100);

        // Deduct fee
        const { rows: walletRows } = await client.query(
          'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
          [userId]
        );
        if (parseFloat(walletRows[0].available) < fastTrackFee) {
          throw Object.assign(new Error('Insufficient balance for fast-track fee.'), { status: 400, code: 'INSUFFICIENT_BALANCE' });
        }

        await client.query('UPDATE wallets SET available = available - $1 WHERE user_id = $2', [fastTrackFee, userId]);
        const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [userId]);
        await client.query(
          `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'FEE', $2, $3, $4)`,
          [userId, -fastTrackFee, w[0].available, `fast_track_${disputeId}`]
        );

        await client.query(
          `UPDATE disputes SET track = 'fast_track', fast_track_payer = $1, fast_track_fee = $2 WHERE id = $3`,
          [userId, fastTrackFee, disputeId]
        );

        // Move match to FAST_TRACK
        await client.query("UPDATE matches SET status = 'FAST_TRACK' WHERE id = $1", [dispute.match_id]);
      } else {
        await client.query("UPDATE disputes SET track = 'standard' WHERE id = $1", [disputeId]);
      }

      const { rows: updated } = await client.query('SELECT * FROM disputes WHERE id = $1', [disputeId]);
      return updated[0];
    });
  },

  async uploadEvidence(userId, disputeId, fileUrl, fileType) {
    await db.query(
      `INSERT INTO dispute_evidence (dispute_id, user_id, file_url, file_type) VALUES ($1, $2, $3, $4)`,
      [disputeId, userId, fileUrl, fileType]
    );
  },

  async escalateToAdmin(userId, disputeId) {
    return db.transaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM disputes WHERE id = $1 FOR UPDATE', [disputeId]);
      const dispute = rows[0];
      if (!dispute) throw Object.assign(new Error('Dispute not found.'), { status: 404 });

      // Check escalation window
      if (dispute.status !== 'RESOLVED' && dispute.status !== 'DECIDED') {
        throw Object.assign(new Error('Dispute not in a state that can be escalated.'), { status: 400 });
      }

      // Must be the losing party
      if (dispute.winner_id === userId) {
        throw Object.assign(new Error('Only the losing party can escalate.'), { status: 400 });
      }

      const escalationFee = configService.get('VAR_ESCALATION_FEE', 100);

      const { rows: walletRows } = await client.query(
        'SELECT available FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (parseFloat(walletRows[0].available) < escalationFee) {
        throw Object.assign(new Error('Insufficient balance for escalation fee.'), { status: 400, code: 'INSUFFICIENT_BALANCE' });
      }

      await client.query('UPDATE wallets SET available = available - $1 WHERE user_id = $2', [escalationFee, userId]);
      const { rows: w } = await client.query('SELECT available FROM wallets WHERE user_id = $1', [userId]);
      await client.query(
        `INSERT INTO token_ledger (user_id, type, amount, balance_after, ref_id) VALUES ($1, 'FEE', $2, $3, $4)`,
        [userId, -escalationFee, w[0].available, `escalation_${disputeId}`]
      );

      await client.query(
        "UPDATE disputes SET status = 'ESCALATED', escalation_fee = $1, escalated_by = $2 WHERE id = $3",
        [escalationFee, userId, disputeId]
      );

      await client.query("UPDATE matches SET status = 'FAST_TRACK' WHERE id = $1", [dispute.match_id]);

      return { escalated: true, fee_paid: escalationFee };
    });
  },
};

module.exports = disputeService;
