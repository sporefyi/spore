-- SPORE backend schema v1 (frozen by coordinator).
-- Every chain-derived row carries chain_id, block_number, tx_hash, log_index,
-- block_time — state is deterministically reconstructible from events.
-- Amounts are NUMERIC storing base asset units as integers (no float math).
-- Idempotency: every event table has UNIQUE(tx_hash, log_index) so log
-- replay is safe (INSERT ... ON CONFLICT DO NOTHING).

CREATE TABLE IF NOT EXISTS sync_state (
    id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_block  BIGINT NOT NULL DEFAULT 0,
    last_hash   TEXT   NOT NULL DEFAULT '',
    deploy_block BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
    agent_id     BIGINT PRIMARY KEY,
    owner        TEXT NOT NULL,
    metadata_uri TEXT NOT NULL DEFAULT '',
    active       BOOLEAN NOT NULL DEFAULT TRUE,
    registered_at TIMESTAMPTZ,
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

-- Current derived state per agent's credit line (rebuilt from events;
-- see docs/EVENT_MAPPING.md for the reconciliation rule re: closeLine).
CREATE TABLE IF NOT EXISTS credit_lines (
    agent_id     BIGINT PRIMARY KEY REFERENCES agents(agent_id),
    line_limit   NUMERIC NOT NULL DEFAULT 0,
    drawn        NUMERIC NOT NULL DEFAULT 0,
    fee_owed     NUMERIC NOT NULL DEFAULT 0,
    fee_bps      INTEGER NOT NULL DEFAULT 0,
    issued_at    TIMESTAMPTZ,
    active       BOOLEAN NOT NULL DEFAULT FALSE,
    defaulted    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS borrows (
    id           BIGSERIAL PRIMARY KEY,
    agent_id     BIGINT NOT NULL REFERENCES agents(agent_id),
    amount       NUMERIC NOT NULL,
    fee          NUMERIC NOT NULL,
    merchant     TEXT NOT NULL,
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS borrows_agent_idx ON borrows (agent_id, block_number);

CREATE TABLE IF NOT EXISTS repays (
    id           BIGSERIAL PRIMARY KEY,
    agent_id     BIGINT NOT NULL REFERENCES agents(agent_id),
    payer        TEXT NOT NULL,
    amount       NUMERIC NOT NULL,
    fee_portion  NUMERIC NOT NULL,
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS repays_agent_idx ON repays (agent_id, block_number);

CREATE TABLE IF NOT EXISTS defaults (
    id            BIGSERIAL PRIMARY KEY,
    agent_id      BIGINT NOT NULL REFERENCES agents(agent_id),
    drawn_amount  NUMERIC NOT NULL,
    covered_amount NUMERIC NOT NULL,
    shortfall     NUMERIC NOT NULL,
    chain_id      INTEGER NOT NULL,
    block_number  BIGINT NOT NULL,
    tx_hash       TEXT NOT NULL,
    log_index     INTEGER NOT NULL,
    block_time    TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

-- Sponsor = BackerVault.deposit (vouch stake). NOTE: withdraw emits NO event
-- in contracts v1, so stake balances here are deposits-only; see
-- docs/EVENT_MAPPING.md (known gap W1).
CREATE TABLE IF NOT EXISTS sponsors (
    id           BIGSERIAL PRIMARY KEY,
    agent_id     BIGINT NOT NULL REFERENCES agents(agent_id),
    backer       TEXT NOT NULL,
    amount       NUMERIC NOT NULL,
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS sponsors_agent_idx ON sponsors (agent_id, block_number);

CREATE TABLE IF NOT EXISTS payments (
    id           BIGSERIAL PRIMARY KEY,
    agent_id     BIGINT NOT NULL REFERENCES agents(agent_id),
    merchant     TEXT NOT NULL,
    amount       NUMERIC NOT NULL,
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS payments_agent_idx ON payments (agent_id, block_number);

CREATE TABLE IF NOT EXISTS revenues (
    id           BIGSERIAL PRIMARY KEY,
    recipient    TEXT NOT NULL,
    amount       NUMERIC NOT NULL,
    kind         TEXT NOT NULL, -- 'treasury' | 'backer-yield' (decoded from bytes32)
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS credit_limit_changes (
    id           BIGSERIAL PRIMARY KEY,
    agent_id     BIGINT NOT NULL REFERENCES agents(agent_id),
    old_limit    NUMERIC NOT NULL,
    new_limit    NUMERIC NOT NULL,
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS yield_allocations (
    id           BIGSERIAL PRIMARY KEY,
    agent_id     BIGINT NOT NULL REFERENCES agents(agent_id),
    amount       NUMERIC NOT NULL,
    chain_id     INTEGER NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    block_time   TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

-- Scores written by the score engine; published_* filled by oracle publisher.
CREATE TABLE IF NOT EXISTS scores (
    agent_id      BIGINT PRIMARY KEY REFERENCES agents(agent_id),
    score         INTEGER NOT NULL CHECK (score >= 0 AND score <= 1000),
    band          TEXT NOT NULL,
    limit_base    NUMERIC NOT NULL, -- suggested max limit, base asset units
    model_version INTEGER NOT NULL,
    dimensions    JSONB NOT NULL,   -- {dim1: n, ..., dim12: n} dimension scores 0..1000
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,
    published_tx  TEXT
);

-- Append-only history for the passport score chart.
CREATE TABLE IF NOT EXISTS score_history (
    id            BIGSERIAL PRIMARY KEY,
    agent_id      BIGINT NOT NULL REFERENCES agents(agent_id),
    score         INTEGER NOT NULL,
    band          TEXT NOT NULL,
    model_version INTEGER NOT NULL,
    computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS score_history_agent_idx ON score_history (agent_id, computed_at);
