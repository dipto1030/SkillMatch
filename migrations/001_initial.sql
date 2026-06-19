-- SkillMatch Database Schema — Initial Migration
-- Based on SRS v1.0 Section 6

-- Users
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT PRIMARY KEY,
  display_name    VARCHAR(100) NOT NULL,
  language        VARCHAR(5) DEFAULT 'en',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  is_banned       BOOLEAN DEFAULT FALSE,
  ban_type        VARCHAR(20),
  ban_until       TIMESTAMPTZ,
  is_frozen       BOOLEAN DEFAULT FALSE,
  warning_count   INT DEFAULT 0,
  active_restriction VARCHAR(50),
  restriction_until TIMESTAMPTZ,
  rep_score       INT DEFAULT 50,
  is_jury         BOOLEAN DEFAULT FALSE,
  jury_active     BOOLEAN DEFAULT FALSE,
  jury_strikes    INT DEFAULT 0,
  shuffle_count_today INT DEFAULT 0,
  shuffle_reset_at TIMESTAMPTZ
);

-- Wallets
CREATE TABLE IF NOT EXISTS wallets (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id),
  available     NUMERIC(20, 4) NOT NULL DEFAULT 0,
  locked        NUMERIC(20, 4) NOT NULL DEFAULT 0,
  admin_hold    NUMERIC(20, 4) NOT NULL DEFAULT 0,
  CHECK (available >= 0),
  CHECK (locked >= 0),
  CHECK (admin_hold >= 0)
);

-- Token Ledger (immutable, append-only)
CREATE TABLE IF NOT EXISTS token_ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  type        VARCHAR(50) NOT NULL,
  amount      NUMERIC(20, 4) NOT NULL,
  balance_after NUMERIC(20, 4) NOT NULL,
  ref_id      VARCHAR(100),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Star Payments (for withdrawal matching)
CREATE TABLE IF NOT EXISTS star_payments (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id),
  stars_amount INT NOT NULL,
  tokens_credited NUMERIC(20,4) NOT NULL,
  charge_id   VARCHAR(200) UNIQUE NOT NULL,
  used_for_withdrawal BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Games
CREATE TABLE IF NOT EXISTS games (
  id              BIGSERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  icon_url        TEXT,
  match_types     VARCHAR(20)[],
  platforms       VARCHAR(20)[],
  max_duration_min INT NOT NULL,
  draws_possible  BOOLEAN DEFAULT FALSE,
  evidence_type   VARCHAR(20) DEFAULT 'screenshot',
  is_active       BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Rule Presets
CREATE TABLE IF NOT EXISTS rule_presets (
  id          BIGSERIAL PRIMARY KEY,
  game_id     BIGINT REFERENCES games(id),
  label       VARCHAR(200) NOT NULL,
  sort_order  INT DEFAULT 0
);

-- Matches
CREATE TABLE IF NOT EXISTS matches (
  id              BIGSERIAL PRIMARY KEY,
  match_code      VARCHAR(20) UNIQUE NOT NULL,
  game_id         BIGINT REFERENCES games(id),
  rule_preset_id  BIGINT REFERENCES rule_presets(id),
  custom_rules    TEXT[],
  rule_proposals  JSONB DEFAULT '[]',
  creator_id      BIGINT REFERENCES users(id),
  opponent_id     BIGINT REFERENCES users(id),
  stake_per_player NUMERIC(20,4) NOT NULL,
  total_pot       NUMERIC(20,4) GENERATED ALWAYS AS (stake_per_player * 2) STORED,
  platform_fee    NUMERIC(20,4),
  status          VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  winner_id       BIGINT REFERENCES users(id),
  creator_result  VARCHAR(20),
  opponent_result VARCHAR(20),
  creator_escrow_locked BOOLEAN DEFAULT FALSE,
  opponent_escrow_locked BOOLEAN DEFAULT FALSE,
  creator_ready   BOOLEAN DEFAULT FALSE,
  opponent_ready  BOOLEAN DEFAULT FALSE,
  result_deadline TIMESTAMPTZ,
  escrow_lock_deadline TIMESTAMPTZ,
  negotiation_deadline TIMESTAMPTZ,
  open_expiry     TIMESTAMPTZ,
  lobby_chat_log  JSONB DEFAULT '[]',
  is_void         BOOLEAN DEFAULT FALSE,
  void_reason     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  locked_at       TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

-- Disputes
CREATE TABLE IF NOT EXISTS disputes (
  id              BIGSERIAL PRIMARY KEY,
  match_id        BIGINT REFERENCES matches(id),
  required_stake  NUMERIC(20,4),
  creator_stake   NUMERIC(20,4),
  opponent_stake  NUMERIC(20,4),
  track           VARCHAR(20),
  fast_track_payer BIGINT REFERENCES users(id),
  fast_track_fee  NUMERIC(20,4),
  escalation_fee  NUMERIC(20,4),
  escalated_by    BIGINT REFERENCES users(id),
  rule_violation_claimant_id BIGINT REFERENCES users(id),
  status          VARCHAR(30) DEFAULT 'PENDING_STAKE',
  winner_id       BIGINT REFERENCES users(id),
  admin_notes     TEXT,
  stake_deadline  TIMESTAMPTZ,
  evidence_deadline TIMESTAMPTZ,
  jury_verdict_at TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Dispute Evidence
CREATE TABLE IF NOT EXISTS dispute_evidence (
  id          BIGSERIAL PRIMARY KEY,
  dispute_id  BIGINT REFERENCES disputes(id),
  user_id     BIGINT REFERENCES users(id),
  file_url    TEXT NOT NULL,
  file_type   VARCHAR(20),
  is_required BOOLEAN DEFAULT TRUE,
  submitted_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jury Cases
CREATE TABLE IF NOT EXISTS jury_cases (
  id          BIGSERIAL PRIMARY KEY,
  dispute_id  BIGINT REFERENCES disputes(id),
  alpha_id    BIGINT REFERENCES users(id),
  beta_id     BIGINT REFERENCES users(id),
  jury_size   INT NOT NULL,
  votes_needed INT NOT NULL,
  deadline    TIMESTAMPTZ NOT NULL,
  status      VARCHAR(20) DEFAULT 'OPEN',
  verdict     VARCHAR(10),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Jury Assignments
CREATE TABLE IF NOT EXISTS jury_assignments (
  id          BIGSERIAL PRIMARY KEY,
  case_id     BIGINT REFERENCES jury_cases(id),
  juror_id    BIGINT REFERENCES users(id),
  vote        VARCHAR(10),
  explanation TEXT,
  voted_at    TIMESTAMPTZ,
  reward_paid NUMERIC(20,4) DEFAULT 0,
  assigned_at TIMESTAMPTZ DEFAULT NOW()
);

-- Jury Skips
CREATE TABLE IF NOT EXISTS jury_skips (
  id          BIGSERIAL PRIMARY KEY,
  juror_id    BIGINT REFERENCES users(id),
  case_id     BIGINT REFERENCES jury_cases(id),
  skipped_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Skill Scores
CREATE TABLE IF NOT EXISTS skill_scores (
  user_id     BIGINT REFERENCES users(id),
  game_id     BIGINT REFERENCES games(id),
  score       INT NOT NULL DEFAULT 1000,
  matches_played INT DEFAULT 0,
  PRIMARY KEY (user_id, game_id)
);

-- Player Reports
CREATE TABLE IF NOT EXISTS player_reports (
  id              BIGSERIAL PRIMARY KEY,
  reporter_id     BIGINT REFERENCES users(id),
  reported_id     BIGINT REFERENCES users(id),
  match_id        BIGINT REFERENCES matches(id),
  reason          VARCHAR(50) NOT NULL,
  description     TEXT,
  is_consecutive  BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Warnings
CREATE TABLE IF NOT EXISTS warnings (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id),
  reason      VARCHAR(200) NOT NULL,
  issued_by   VARCHAR(50),
  expires_at  TIMESTAMPTZ NOT NULL,
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Name Change Log
CREATE TABLE IF NOT EXISTS name_change_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id),
  new_name    VARCHAR(100) NOT NULL,
  changed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Debts (for fast-track fee recovery)
CREATE TABLE IF NOT EXISTS debts (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT REFERENCES users(id),
  amount_remaining NUMERIC(20,4) NOT NULL,
  reason          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Admin Audit Log (immutable)
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    BIGINT NOT NULL,
  action      VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id   BIGINT,
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Platform Config
CREATE TABLE IF NOT EXISTS platform_config (
  key         VARCHAR(100) PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_by  BIGINT
);

-- Admin Users
CREATE TABLE IF NOT EXISTS admin_users (
  id              BIGSERIAL PRIMARY KEY,
  username        VARCHAR(100) UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_creator ON matches(creator_id);
CREATE INDEX IF NOT EXISTS idx_matches_opponent ON matches(opponent_id);
CREATE INDEX IF NOT EXISTS idx_matches_game ON matches(game_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_user ON token_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_token_ledger_created ON token_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_disputes_match ON disputes(match_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_jury_assignments_case ON jury_assignments(case_id);
CREATE INDEX IF NOT EXISTS idx_jury_assignments_juror ON jury_assignments(juror_id);
CREATE INDEX IF NOT EXISTS idx_skill_scores_game ON skill_scores(game_id);
CREATE INDEX IF NOT EXISTS idx_player_reports_reported ON player_reports(reported_id);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings(user_id);
CREATE INDEX IF NOT EXISTS idx_star_payments_user ON star_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_star_payments_charge ON star_payments(charge_id);
