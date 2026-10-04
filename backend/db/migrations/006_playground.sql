-- SPORE Playground: credit ledger funded by $SPORE burns or USDG merchant payments.
CREATE TABLE IF NOT EXISTS playground_credits (
  wallet TEXT PRIMARY KEY,
  credits BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS playground_burns (
  id SERIAL PRIMARY KEY,
  wallet TEXT NOT NULL,
  tx_hash TEXT UNIQUE NOT NULL,
  spore_amount TEXT NOT NULL,
  credits_granted BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_playground_burns_wallet ON playground_burns(wallet);
CREATE TABLE IF NOT EXISTS playground_usage (
  id SERIAL PRIMARY KEY,
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  credits_spent BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- USDG merchant payments converted into playground credits (1 USDG = 1000 credits).
CREATE TABLE IF NOT EXISTS playground_merchant_spends (
  id SERIAL PRIMARY KEY,
  wallet TEXT NOT NULL,
  payment_tx TEXT UNIQUE NOT NULL,
  usdg_amount TEXT NOT NULL,
  credits_granted BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_playground_merchant_spends_wallet ON playground_merchant_spends(wallet);
