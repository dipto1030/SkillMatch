require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const defaults = [
  // Token System
  ['VAR_TOKEN_RATE', '1', 'Stars required for 1 Token'],
  ['VAR_MIN_DEPOSIT', '10', 'Minimum Token deposit'],
  ['VAR_MIN_WITHDRAWAL', '10', 'Minimum Token withdrawal'],

  // Staking
  ['VAR_MIN_STAKE', '10', 'Minimum stake per match'],
  ['VAR_MAX_STAKE_PERCENT', '0.7', 'Max % of available balance stakeable'],
  ['VAR_NEW_ACCOUNT_PERIOD', '7', 'Days of new account stake restriction'],
  ['VAR_NEW_ACCOUNT_STAKE_LIMIT', '100', 'Max stake for new accounts'],

  // Reshuffling
  ['VAR_FREE_SHUFFLES_PER_DAY', '5', 'Free reshuffles per day'],
  ['VAR_EXTRA_SHUFFLE_FEE', '5', 'Tokens per extra reshuffle'],

  // Match Timing
  ['VAR_RULE_NEGOTIATION_WINDOW', '5', 'Minutes for rule negotiation'],
  ['VAR_RESULT_SUBMISSION_WINDOW', '15', 'Extra minutes for result submission'],
  ['VAR_REMINDER_INTERVAL', '5', 'Minutes between result reminders'],
  ['VAR_ABANDONED_GRACE', '10', 'Grace minutes after deadline'],
  ['VAR_ESCROW_LOCK_WINDOW', '10', 'Minutes to pay escrow'],
  ['VAR_OPEN_MATCH_EXPIRY', '24', 'Hours before open match auto-cancels'],
  ['VAR_DEADLINE_WARNING', '5', 'Minutes before deadline for final warning'],

  // Fees
  ['VAR_PLATFORM_FEE', '0.05', 'Platform fee percentage (5%)'],
  ['VAR_ADMIN_DISPUTE_CUT', '0.2', 'Admin cut of dispute stakes (20%)'],
  ['VAR_JURY_REWARD_PERCENT', '0.3', 'Jury reward from dispute stakes (30%)'],
  ['VAR_FAST_DISPUTE_FEE', '100', 'Tokens for fast-track dispute'],
  ['VAR_ESCALATION_FEE', '100', 'Tokens for post-jury escalation'],

  // Dispute
  ['VAR_DISPUTE_STAKE_MIN', '50', 'Minimum dispute stake floor'],
  ['VAR_DISPUTE_STAKE_PERCENT', '0.35', 'Dispute stake as % of match stake'],
  ['VAR_DISPUTE_STAKE_WINDOW', '60', 'Minutes to pay dispute stake'],
  ['VAR_EVIDENCE_WINDOW', '24', 'Hours to submit dispute evidence'],
  ['VAR_FAST_TRACK_WINDOW', '12', 'Target hours for fast-track resolution'],
  ['VAR_ESCALATION_WINDOW', '24', 'Hours to escalate post-jury'],

  // Jury
  ['VAR_JURY_BADGE_COST', '200', 'Tokens for jury badge'],
  ['VAR_MIN_JURY_AGE', '2', 'Min account age in months for jury'],
  ['VAR_MIN_JURY_MATCHES', '20', 'Min completed matches for jury'],
  ['VAR_MAX_JURY_DISPUTES_LOST', '2', 'Max disputes lost for jury eligibility'],
  ['VAR_MAX_JURY_WARNINGS', '1', 'Max active warnings for jury'],
  ['VAR_JURY_SIZE_S', '3', 'Jurors for small matches'],
  ['VAR_JURY_SIZE_M', '5', 'Jurors for medium matches'],
  ['VAR_JURY_SIZE_L', '7', 'Jurors for large matches'],
  ['VAR_STAKE_TIER_M', '500', 'Medium match threshold'],
  ['VAR_STAKE_TIER_L', '2000', 'Large match threshold'],
  ['VAR_JURY_WINDOW', '48', 'Hours for jury voting'],
  ['VAR_ADMIN_RESOLVE_WINDOW', '24', 'Hours for admin resolve'],
  ['VAR_JURY_STRIKES_TO_SUSPEND', '3', 'Strikes before badge suspended'],
  ['VAR_CONSECUTIVE_ABSENCES', '2', 'Consecutive no-votes before suspension'],
  ['VAR_ABSENCE_SUSPENSION_DAYS', '14', 'Days suspended for absences'],
  ['VAR_STRIKE_SUSPENSION_DAYS', '30', 'Days suspended per strike breach'],
  ['VAR_JURY_INACTIVITY_DAYS', '30', 'Days inactive before auto-suspend'],
  ['VAR_JURY_SKIPS_PER_MONTH', '2', 'Allowed case skips per month'],
  ['VAR_ADDITIONAL_EVIDENCE_REQUEST_WINDOW', '12', 'Hours jurors can request evidence'],

  // Accounts & Reputation
  ['VAR_WARNING_EXPIRY', '30', 'Days before warning expires'],
  ['VAR_TEMP_BAN_1', '7', 'Days for 3rd-offence ban'],
  ['VAR_TEMP_BAN_2', '30', 'Days for 4th-offence ban'],
  ['VAR_STAKE_RESTRICTION_DAYS', '14', 'Days of stake restriction'],
  ['VAR_RESTRICTED_MAX_STAKE', '50', 'Max stake during restriction'],
  ['VAR_APPEAL_REVIEW_WINDOW', '48', 'Hours for admin appeal review'],
  ['VAR_MAX_NAME_CHANGES', '3', 'Max display name changes per month'],
  ['VAR_REP_PER_MATCH', '2', 'Rep gain per clean match'],
  ['VAR_REP_DISPUTE_WIN', '3', 'Rep gain per won dispute'],
  ['VAR_REP_DISPUTE_LOSS', '5', 'Rep loss per lost dispute'],
  ['VAR_REP_PER_WARNING', '3', 'Rep loss per warning'],
  ['VAR_REP_AGE_BONUS', '1', 'Monthly rep bonus'],
  ['VAR_REP_AGE_MAX', '10', 'Max rep from account age'],
  ['VAR_REP_PER_REPORT', '5', 'Rep loss per verified report'],

  // Reports & Fraud
  ['VAR_REPORT_THRESHOLD', '5', 'Consecutive reports to auto-freeze'],
  ['VAR_REPORT_WINDOW', '30', 'Days for report counting window'],
  ['VAR_FRAUD_WIN_RATE_THRESHOLD', '85', 'Win rate % for fraud flag'],
  ['VAR_FRAUD_MIN_MATCHES', '10', 'Min matches before fraud flag active'],
  ['VAR_FRAUD_DISPUTE_RATE', '30', 'Dispute rate % for fraud flag'],
  ['VAR_SAME_OPPONENT_LIMIT', '3', 'Max matches vs same opponent in 24h'],
  ['VAR_HIGH_STAKES_THRESHOLD', '5000', 'Tokens for admin FYI alert'],

  // Skill Score
  ['VAR_SKILL_SCORE_START', '1000', 'Starting skill score'],
  ['VAR_SKILL_RANK_CALIBRATION', '10', 'Matches before calibrated'],
  ['VAR_SMURF_WIN_STREAK', '7', 'Consecutive wins for smurf flag'],
  ['VAR_SKILL_WIN_LOW', '10', 'Score gain vs lower-ranked'],
  ['VAR_SKILL_WIN_MID', '20', 'Score gain vs same-ranked'],
  ['VAR_SKILL_WIN_HIGH', '30', 'Score gain vs higher-ranked'],
  ['VAR_SKILL_LOSS_LOW', '30', 'Score loss to lower-ranked'],
  ['VAR_SKILL_LOSS_MID', '20', 'Score loss to same-ranked'],
  ['VAR_SKILL_LOSS_HIGH', '10', 'Score loss to higher-ranked'],
  ['VAR_TIER_1_MIN', '0', 'Beginner tier min'],
  ['VAR_TIER_1_MAX', '800', 'Beginner tier max'],
  ['VAR_TIER_2_MIN', '801', 'Intermediate tier min'],
  ['VAR_TIER_2_MAX', '1200', 'Intermediate tier max'],
  ['VAR_TIER_3_MIN', '1201', 'Advanced tier min'],
  ['VAR_TIER_3_MAX', '1600', 'Advanced tier max'],
  ['VAR_TIER_4_MIN', '1601', 'Elite tier min'],

  // Penalties & Special
  ['VAR_DQ_REWARD_PERCENT', '0.5', '% of DQ player wallet to opponent'],
  ['VAR_CHAT_LOG_RETENTION', '90', 'Days to retain chat logs'],
  ['VAR_HISTORY_PREVIEW', '10', 'Recent matches on profile'],
  ['VAR_FOUNDING_JURY_COUNT', '10', 'Founding jurors to hand-pick'],
  ['VAR_FOUNDING_JURY_MIN_MATCHES', '5', 'Min matches for founding juror'],
];

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Seed platform config
    for (const [key, value, description] of defaults) {
      await pool.query(
        `INSERT INTO platform_config (key, value, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING`,
        [key, value, description]
      );
    }
    console.log(`✓ Seeded ${defaults.length} platform config values`);

    // Create default admin user (password: admin123 — change in production!)
    const hash = await bcrypt.hash('admin123', 10);
    await pool.query(
      `INSERT INTO admin_users (username, password_hash) VALUES ('admin', $1) ON CONFLICT DO NOTHING`,
      [hash]
    );
    console.log('✓ Default admin user created (admin / admin123)');

  } catch (err) {
    console.error('Seed error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
