-- SPORE GPU rentals via RunPod (real GPU rental, paid in USDG)
CREATE TABLE IF NOT EXISTS gpu_rentals (
  id SERIAL PRIMARY KEY,
  gpu_type_id TEXT NOT NULL,
  gpu_display TEXT NOT NULL,
  hours NUMERIC NOT NULL,
  hourly_rate NUMERIC NOT NULL,
  price_usdg NUMERIC NOT NULL,
  payment_tx TEXT UNIQUE NOT NULL,
  payer TEXT NOT NULL,
  pod_id TEXT,
  pod_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gpu_rentals_payer ON gpu_rentals(payer);
CREATE INDEX IF NOT EXISTS idx_gpu_rentals_expires ON gpu_rentals(expires_at) WHERE terminated_at IS NULL;
