const db = require('../config/database');
const configService = require('./configService');
const adminAlerts = require('../bot/adminBot');

const reportService = {
  async reportPlayer(reporterId, reportedId, matchId, reason, description) {
    const validReasons = [
      'abusive_chat', 'match_fixing', 'bot_automation',
      'multi_accounting', 'other',
    ];
    if (!validReasons.includes(reason)) {
      throw Object.assign(new Error('Invalid report reason.'), { status: 400 });
    }

    // Rate limit: one report per match per reporter
    if (matchId) {
      const { rows: existing } = await db.query(
        'SELECT id FROM player_reports WHERE reporter_id = $1 AND match_id = $2',
        [reporterId, matchId]
      );
      if (existing.length > 0) {
        throw Object.assign(new Error('Already reported this player for this match.'), { status: 400 });
      }
    }

    return db.transaction(async (client) => {
      await client.query(
        `INSERT INTO player_reports (reporter_id, reported_id, match_id, reason, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [reporterId, reportedId, matchId, reason, description]
      );

      // Check consecutive report count
      const reportThreshold = configService.get('VAR_REPORT_THRESHOLD', 5);
      const reportWindow = configService.get('VAR_REPORT_WINDOW', 30);

      const { rows: reports } = await client.query(
        `SELECT COUNT(DISTINCT reporter_id) as cnt FROM player_reports
         WHERE reported_id = $1 AND is_consecutive = TRUE
         AND created_at > NOW() - INTERVAL '${reportWindow} days'`,
        [reportedId]
      );

      const reportCount = parseInt(reports[0].cnt);

      if (reportCount >= reportThreshold) {
        // Auto-freeze account
        await client.query('UPDATE users SET is_frozen = TRUE WHERE id = $1', [reportedId]);

        adminAlerts.accountFrozen({ display_name: reportedId }, reportCount);

        // Notify player
        const bot = require('../bot');
        await bot.sendNotification(
          reportedId,
          '⚠️ Your account has been frozen due to multiple reports.\nAn admin will review your account shortly.'
        );
      }

      // Update reputation
      const repLoss = configService.get('VAR_REP_PER_REPORT', 5);
      await client.query(
        'UPDATE users SET rep_score = GREATEST(0, rep_score - $1) WHERE id = $2',
        [repLoss, reportedId]
      );

      return { reported: true, report_count: reportCount };
    });
  },
};

module.exports = reportService;
