-- SPORE GPU rentals: store the SPORE-denominated price (exact base units as text)
ALTER TABLE gpu_rentals ADD COLUMN IF NOT EXISTS price_spore TEXT;
