-- SPORE Storage merchant: pin jobs queue.
-- The API verifies USDG payment on-chain and queues the file;
-- a VM worker polls pending jobs and pins via Pinata (credential lives on VM).

CREATE TABLE IF NOT EXISTS storage_pins (
  id SERIAL PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_data BYTEA NOT NULL,
  payment_tx TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'pinning', 'done', 'failed')),
  cid TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_pins_status ON storage_pins(status);
