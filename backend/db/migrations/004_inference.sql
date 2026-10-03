-- SPORE Inference merchant: paid AI chat completions.
-- One inference request per USDG payment (payment_tx unique, no double-spend).

CREATE TABLE IF NOT EXISTS inference_requests (
  id SERIAL PRIMARY KEY,
  model TEXT NOT NULL,
  messages JSONB NOT NULL,
  payment_tx TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  response TEXT NOT NULL,
  tokens_used INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inference_requests_payer ON inference_requests(payer);
