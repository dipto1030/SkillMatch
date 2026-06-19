const { Queue, Worker } = require('bullmq');
const redis = require('../config/redis');
const db = require('../config/database');
const configService = require('../services/configService');

const connection = { connection: redis };

// Queues
const matchQueue = new Queue('match-jobs', connection);
const disputeQueue = new Queue('dispute-jobs', connection);
const reminderQueue = new Queue('reminder-jobs', connection);

// Schedule deadline jobs when matches change state
const jobs = {
  async scheduleEscrowExpiry(matchId, deadline) {
    const delay = new Date(deadline).getTime() - Date.now();
    if (delay > 0) {
      await matchQueue.add('escrow_lock_expire', { matchId }, { delay, jobId: `escrow_${matchId}` });
    }
  },

  async scheduleNegotiationExpiry(matchId, deadline) {
    const delay = new Date(deadline).getTime() - Date.now();
    if (delay > 0) {
      await matchQueue.add('negotiation_expire', { matchId }, { delay, jobId: `neg_${matchId}` });
    }
  },

  async scheduleResultDeadline(matchId, deadline) {
    const delay = new Date(deadline).getTime() - Date.now();
    if (delay > 0) {
      await matchQueue.add('result_deadline_check', { matchId }, { delay, jobId: `result_${matchId}` });
    }
  },

  async scheduleResultReminder(matchId, nonSubmitterId) {
    const interval = configService.get('VAR_REMINDER_INTERVAL', 5) * 60 * 1000;
    await reminderQueue.add('result_reminder', { matchId, userId: nonSubmitterId }, {
      delay: interval,
      jobId: `reminder_${matchId}_${Date.now()}`,
    });
  },

  async scheduleDisputeStakeExpiry(disputeId, deadline) {
    const delay = new Date(deadline).getTime() - Date.now();
    if (delay > 0) {
      await disputeQueue.add('dispute_stake_expire', { disputeId }, { delay, jobId: `dstake_${disputeId}` });
    }
  },

  async scheduleEvidenceExpiry(disputeId, deadline) {
    const delay = new Date(deadline).getTime() - Date.now();
    if (delay > 0) {
      await disputeQueue.add('evidence_expire', { disputeId }, { delay, jobId: `evidence_${disputeId}` });
    }
  },

  async scheduleJuryDeadline(caseId, deadline) {
    const delay = new Date(deadline).getTime() - Date.now();
    if (delay > 0) {
      await disputeQueue.add('jury_deadline', { caseId }, { delay, jobId: `jury_${caseId}` });
    }
  },
};

// Workers
const matchWorker = new Worker('match-jobs', async (job) => {
  const { matchId } = job.data;

  switch (job.name) {
    case 'escrow_lock_expire': {
      const { rows } = await db.query('SELECT * FROM matches WHERE id = $1', [matchId]);
      const match = rows[0];
      if (!match || match.status !== 'ACCEPTED') return;

      await db.transaction(async (client) => {
        // Refund anyone who locked
        const stake = parseFloat(match.stake_per_player);
        if (match.creator_escrow_locked) {
          await client.query('UPDATE wallets SET locked = locked - $1, available = available + $1 WHERE user_id = $2', [stake, match.creator_id]);
        }
        if (match.opponent_escrow_locked) {
          await client.query('UPDATE wallets SET locked = locked - $1, available = available + $1 WHERE user_id = $2', [stake, match.opponent_id]);
        }

        await client.query("UPDATE matches SET status = 'CANCELLED', is_void = TRUE, void_reason = 'Escrow lock window expired' WHERE id = $1", [matchId]);

        // Warn non-locking player(s)
        const warningExpiry = configService.get('VAR_WARNING_EXPIRY', 30);
        if (!match.creator_escrow_locked) {
          await client.query(`INSERT INTO warnings (user_id, reason, issued_by, expires_at) VALUES ($1, 'Failed to lock escrow', 'system', NOW() + INTERVAL '${warningExpiry} days')`, [match.creator_id]);
          await client.query('UPDATE users SET warning_count = warning_count + 1 WHERE id = $1', [match.creator_id]);
        }
        if (!match.opponent_escrow_locked) {
          await client.query(`INSERT INTO warnings (user_id, reason, issued_by, expires_at) VALUES ($1, 'Failed to lock escrow', 'system', NOW() + INTERVAL '${warningExpiry} days')`, [match.opponent_id]);
          await client.query('UPDATE users SET warning_count = warning_count + 1 WHERE id = $1', [match.opponent_id]);
        }
      });
      break;
    }

    case 'negotiation_expire': {
      const { rows } = await db.query('SELECT * FROM matches WHERE id = $1', [matchId]);
      const match = rows[0];
      if (!match || match.status !== 'NEGOTIATING') return;

      const matchService = require('../services/matchService');
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        await matchService._activateMatch(client, matchId, match);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      break;
    }

    case 'result_deadline_check': {
      const { rows } = await db.query('SELECT * FROM matches WHERE id = $1', [matchId]);
      const match = rows[0];
      if (!match || !['ACTIVE', 'RESULT_PENDING'].includes(match.status)) return;

      await db.transaction(async (client) => {
        const stake = parseFloat(match.stake_per_player);
        const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
        const pot = stake * 2;
        const fee = Math.round(pot * platformFee * 100) / 100;

        if (match.creator_result && !match.opponent_result) {
          // Creator submitted, opponent didn't — creator wins by default
          const matchService = require('../services/matchService');
          await matchService._awardWinner(client, match, match.creator_id, match.opponent_id, pot, fee);
        } else if (!match.creator_result && match.opponent_result) {
          // Opponent submitted, creator didn't — opponent wins by default
          const matchService = require('../services/matchService');
          await matchService._awardWinner(client, match, match.opponent_id, match.creator_id, pot, fee);
        } else if (!match.creator_result && !match.opponent_result) {
          // Neither submitted — abandoned
          const grace = configService.get('VAR_ABANDONED_GRACE', 10);
          // Schedule grace period check
          await matchQueue.add('abandoned_grace', { matchId }, { delay: grace * 60 * 1000 });
        }
      });
      break;
    }

    case 'abandoned_grace': {
      const { rows } = await db.query('SELECT * FROM matches WHERE id = $1', [matchId]);
      const match = rows[0];
      if (!match || match.status !== 'ACTIVE') return;

      if (!match.creator_result && !match.opponent_result) {
        const matchService = require('../services/matchService');
        const stake = parseFloat(match.stake_per_player);
        const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
        await db.transaction(async (client) => {
          await matchService._mutualForfeit(client, match, stake, platformFee);
        });
      }
      break;
    }
  }
}, connection);

const disputeWorker = new Worker('dispute-jobs', async (job) => {
  switch (job.name) {
    case 'dispute_stake_expire': {
      const { disputeId } = job.data;
      const { rows } = await db.query('SELECT * FROM disputes WHERE id = $1', [disputeId]);
      const dispute = rows[0];
      if (!dispute || dispute.status !== 'PENDING_STAKE') return;

      await db.transaction(async (client) => {
        // Non-payer loses
        const { rows: matchRows } = await client.query('SELECT * FROM matches WHERE id = $1', [dispute.match_id]);
        const match = matchRows[0];

        let winnerId, loserId;
        if (dispute.creator_stake && !dispute.opponent_stake) {
          winnerId = match.creator_id;
          loserId = match.opponent_id;
        } else if (!dispute.creator_stake && dispute.opponent_stake) {
          winnerId = match.opponent_id;
          loserId = match.creator_id;
        } else {
          // Neither paid — void
          await client.query("UPDATE disputes SET status = 'RESOLVED_DEFAULT' WHERE id = $1", [disputeId]);
          return;
        }

        const matchService = require('../services/matchService');
        const stake = parseFloat(match.stake_per_player);
        const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
        const pot = stake * 2;
        const fee = Math.round(pot * platformFee * 100) / 100;
        await matchService._awardWinner(client, match, winnerId, loserId, pot, fee);
        await client.query("UPDATE disputes SET status = 'RESOLVED_DEFAULT', winner_id = $1 WHERE id = $2", [winnerId, disputeId]);
      });
      break;
    }

    case 'evidence_expire': {
      const { disputeId } = job.data;
      const { rows } = await db.query('SELECT * FROM disputes WHERE id = $1', [disputeId]);
      const dispute = rows[0];
      if (!dispute || dispute.status !== 'PENDING_EVIDENCE') return;

      // Check who submitted evidence
      const { rows: evidence } = await db.query(
        'SELECT DISTINCT user_id FROM dispute_evidence WHERE dispute_id = $1',
        [disputeId]
      );
      const submitters = evidence.map(e => e.user_id);
      const { rows: matchRows } = await db.query('SELECT * FROM matches WHERE id = $1', [dispute.match_id]);
      const match = matchRows[0];

      if (submitters.length === 0) {
        // Neither submitted — void
        return;
      }

      // Non-submitter loses
      const allParticipants = [match.creator_id, match.opponent_id];
      const nonSubmitter = allParticipants.find(id => !submitters.includes(id));

      if (nonSubmitter) {
        const winnerId = allParticipants.find(id => id !== nonSubmitter);
        await db.transaction(async (client) => {
          const matchService = require('../services/matchService');
          const stake = parseFloat(match.stake_per_player);
          const platformFee = configService.get('VAR_PLATFORM_FEE', 0.05);
          const pot = stake * 2;
          const fee = Math.round(pot * platformFee * 100) / 100;
          await matchService._awardWinner(client, match, winnerId, nonSubmitter, pot, fee);
          await client.query("UPDATE disputes SET status = 'RESOLVED_DEFAULT', winner_id = $1 WHERE id = $2", [winnerId, disputeId]);
        });
      }
      break;
    }

    case 'jury_deadline': {
      const { caseId } = job.data;
      const { rows } = await db.query('SELECT * FROM jury_cases WHERE id = $1', [caseId]);
      const juryCase = rows[0];
      if (!juryCase || juryCase.status !== 'OPEN') return;

      const { rows: votes } = await db.query(
        'SELECT vote FROM jury_assignments WHERE case_id = $1 AND vote IS NOT NULL',
        [caseId]
      );

      if (votes.length >= juryCase.votes_needed) {
        // Tally votes
        const alphaVotes = votes.filter(v => v.vote === 'ALPHA').length;
        const betaVotes = votes.filter(v => v.vote === 'BETA').length;
        const verdict = alphaVotes > betaVotes ? 'ALPHA' : 'BETA';

        await db.query("UPDATE jury_cases SET status = 'DECIDED', verdict = $1 WHERE id = $2", [verdict, caseId]);
        const juryService = require('../services/juryService');
        const client = await db.getClient();
        try {
          await client.query('BEGIN');
          await juryService._resolveJuryVerdict(client, juryCase, verdict, votes);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      } else {
        // Quorum not reached — escalate to admin
        await db.query("UPDATE jury_cases SET status = 'ESCALATED' WHERE id = $1", [caseId]);
        await db.query("UPDATE disputes SET status = 'ESCALATED' WHERE id = $1", [juryCase.dispute_id]);
        const { rows: disputeRows } = await db.query('SELECT match_id FROM disputes WHERE id = $1', [juryCase.dispute_id]);
        await db.query("UPDATE matches SET status = 'FAST_TRACK' WHERE id = $1", [disputeRows[0].match_id]);
      }
      break;
    }
  }
}, connection);

const reminderWorker = new Worker('reminder-jobs', async (job) => {
  if (job.name === 'result_reminder') {
    const { matchId, userId } = job.data;
    const { rows } = await db.query('SELECT * FROM matches WHERE id = $1', [matchId]);
    const match = rows[0];
    if (!match || match.status !== 'RESULT_PENDING') return;

    const bot = require('../bot');
    await bot.sendNotification(userId,
      `⏰ Reminder: Your opponent has submitted their result for match ${match.match_code}. Please submit yours before the deadline.`
    );

    // Schedule next reminder if deadline hasn't passed
    if (new Date(match.result_deadline) > new Date()) {
      await jobs.scheduleResultReminder(matchId, userId);
    }
  }
}, connection);

matchWorker.on('failed', (job, err) => console.error(`Match job ${job?.name} failed:`, err.message));
disputeWorker.on('failed', (job, err) => console.error(`Dispute job ${job?.name} failed:`, err.message));
reminderWorker.on('failed', (job, err) => console.error(`Reminder job ${job?.name} failed:`, err.message));

module.exports = jobs;
