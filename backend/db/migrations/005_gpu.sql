-- SPORE GPU merchant: image generations via Replicate
CREATE TABLE IF NOT EXISTS gpu_generations (
  id SERIAL PRIMARY KEY,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  payment_tx TEXT UNIQUE NOT NULL,
  payer TEXT NOT NULL,
  output_urls JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gpu_generations_payer ON gpu_generations(payer);
