-- ============================================================================
-- EPO.SI — Migration 015: Persist each ingredient's target cost ratio
-- ----------------------------------------------------------------------------
-- The "Ciljni delez stroska" (target cost ratio) field in the ingredient
-- modal was UI-only — it reset to the hardcoded 30% default every time the
-- modal reopened, even for an ingredient the owner had deliberately set to
-- e.g. 8% (coffee). This column makes it a real, saved property of the
-- ingredient, so it's remembered and can drive automatic sale-price
-- recalculation when the purchase price changes (see js/inventory.js).
-- Run AFTER 004_ingredients.sql. Idempotent.
-- ============================================================================

ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS target_cost_ratio NUMERIC(5,2) DEFAULT 30;
