const db = require('../config/database');
const configService = require('./configService');

const scoreService = {
  async updateScores(client, gameId, winnerId, loserId) {
    const startScore = configService.get('VAR_SKILL_SCORE_START', 1000);

    // Ensure both have score records
    for (const uid of [winnerId, loserId]) {
      await client.query(
        `INSERT INTO skill_scores (user_id, game_id, score, matches_played)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (user_id, game_id) DO NOTHING`,
        [uid, gameId, startScore]
      );
    }

    // Get current scores
    const { rows: winnerScore } = await client.query(
      'SELECT score FROM skill_scores WHERE user_id = $1 AND game_id = $2',
      [winnerId, gameId]
    );
    const { rows: loserScore } = await client.query(
      'SELECT score FROM skill_scores WHERE user_id = $1 AND game_id = $2',
      [loserId, gameId]
    );

    const wScore = winnerScore[0].score;
    const lScore = loserScore[0].score;

    // Determine rank relationship
    let winGain, lossAmount;
    const diff = wScore - lScore;

    if (diff > 100) {
      // Winner is higher ranked
      winGain = configService.get('VAR_SKILL_WIN_LOW', 10);
      lossAmount = configService.get('VAR_SKILL_LOSS_HIGH', 10);
    } else if (diff < -100) {
      // Winner is lower ranked (upset)
      winGain = configService.get('VAR_SKILL_WIN_HIGH', 30);
      lossAmount = configService.get('VAR_SKILL_LOSS_LOW', 30);
    } else {
      // Same rank
      winGain = configService.get('VAR_SKILL_WIN_MID', 20);
      lossAmount = configService.get('VAR_SKILL_LOSS_MID', 20);
    }

    await client.query(
      'UPDATE skill_scores SET score = score + $1, matches_played = matches_played + 1 WHERE user_id = $2 AND game_id = $3',
      [winGain, winnerId, gameId]
    );
    await client.query(
      'UPDATE skill_scores SET score = GREATEST(0, score - $1), matches_played = matches_played + 1 WHERE user_id = $2 AND game_id = $3',
      [lossAmount, loserId, gameId]
    );
  },

  async getLeaderboard(gameId, limit = 50) {
    const { rows } = await db.query(
      `SELECT ss.*, u.display_name FROM skill_scores ss
       JOIN users u ON u.id = ss.user_id
       WHERE ss.game_id = $1
       ORDER BY ss.score DESC LIMIT $2`,
      [gameId, limit]
    );
    return rows;
  },

  getSkillTier(score) {
    const t1Max = configService.get('VAR_TIER_1_MAX', 800);
    const t2Max = configService.get('VAR_TIER_2_MAX', 1200);
    const t3Max = configService.get('VAR_TIER_3_MAX', 1600);

    if (score <= t1Max) return 'Beginner';
    if (score <= t2Max) return 'Intermediate';
    if (score <= t3Max) return 'Advanced';
    return 'Elite';
  },
};

module.exports = scoreService;
