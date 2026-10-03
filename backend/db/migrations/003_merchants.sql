-- SPORE merchants batch 2: Data, RPC, Search.
-- Each merchant verifies a USDG payment on-chain; payment_tx is unique per
-- merchant table (one query/key/search per payment, no double-spend).

-- Lane 1: SPORE Data — paid chain-data queries (balance / tx / block).
CREATE TABLE IF NOT EXISTS data_queries (
  id SERIAL PRIMARY KEY,
  query_type TEXT NOT NULL CHECK (query_type IN ('balance', 'tx', 'block')),
  query_params JSONB NOT NULL,
  payment_tx TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_queries_payer ON data_queries(payer);

-- Lane 2: SPORE RPC — metered JSON-RPC proxy keys (5 USDG / 30 days).
-- Only the SHA256 hash of the key is stored; the raw key is shown once.
CREATE TABLE IF NOT EXISTS rpc_keys (
  id SERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  payment_tx TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rpc_keys_payer ON rpc_keys(payer);

-- Lane 3: SPORE Search — paid web-search queries.
CREATE TABLE IF NOT EXISTS search_queries (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  payment_tx TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  results JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_search_queries_payer ON search_queries(payer);
