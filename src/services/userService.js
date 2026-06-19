const db = require('../config/database');
const adminAlerts = require('../bot/adminBot');

const userService = {
  async register({ id, display_name, language }) {
    return db.transaction(async (client) => {
      // Create user
      const { rows } = await client.query(
        `INSERT INTO users (id, display_name, language)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET display_name = users.display_name
         RETURNING *`,
        [id, display_name, language || 'en']
      );
      const user = rows[0];

      // Create wallet
      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [id]
      );

      // Log
      adminAlerts.newRegistration(user);
      return user;
    });
  },

  async getById(userId) {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    return rows[0] || null;
  },

  async getWalletSummary(userId) {
    const { rows } = await db.query(
      'SELECT available, locked, admin_hold FROM wallets WHERE user_id = $1',
      [userId]
    );
    return rows[0] || { available: 0, locked: 0, admin_hold: 0 };
  },

  async getPublicProfile(userId) {
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.created_at, u.rep_score, u.warning_count,
              u.is_banned, u.active_restriction,
              (SELECT COUNT(*) FROM matches WHERE (creator_id = u.id OR opponent_id = u.id) AND status IN ('COMPLETED', 'RESOLVED')) as total_matches,
              (SELECT COUNT(*) FROM matches WHERE winner_id = u.id AND status IN ('COMPLETED', 'RESOLVED')) as wins,
              (SELECT COUNT(*) FROM matches WHERE (creator_id = u.id OR opponent_id = u.id) AND winner_id IS NOT NULL AND winner_id != u.id AND status IN ('COMPLETED', 'RESOLVED')) as losses
       FROM users u WHERE u.id = $1`,
      [userId]
    );
    if (!rows[0]) return null;

    const profile = rows[0];
    profile.total_matches = parseInt(profile.total_matches, 10);
    profile.wins = parseInt(profile.wins, 10);
    profile.losses = parseInt(profile.losses, 10);
    profile.draws = profile.total_matches - profile.wins - profile.losses;
    profile.win_rate = profile.total_matches > 0
      ? Math.round((profile.wins / profile.total_matches) * 100)
      : 0;

    // Skill scores per game
    const { rows: scores } = await db.query(
      `SELECT ss.game_id, g.name as game_name, ss.score, ss.matches_played
       FROM skill_scores ss JOIN games g ON g.id = ss.game_id
       WHERE ss.user_id = $1`,
      [userId]
    );
    profile.skill_scores = scores;

    return profile;
  },

  async updateDisplayName(userId, newName) {
    const configService = require('./configService');
    const maxChanges = configService.get('VAR_MAX_NAME_CHANGES', 3);

    // Check monthly change count
    const { rows } = await db.query(
      `SELECT COUNT(*) as cnt FROM name_change_log
       WHERE user_id = $1 AND changed_at > NOW() - INTERVAL '30 days'`,
      [userId]
    );

    if (parseInt(rows[0].cnt, 10) >= maxChanges) {
      throw Object.assign(new Error('Monthly name change limit reached.'), { status: 400, code: 'NAME_CHANGE_LIMIT' });
    }

    await db.transaction(async (client) => {
      await client.query('UPDATE users SET display_name = $1 WHERE id = $2', [newName, userId]);
      await client.query(
        'INSERT INTO name_change_log (user_id, new_name) VALUES ($1, $2)',
        [userId, newName]
      );
    });
  },
};

module.exports = userService;
