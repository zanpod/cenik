-- ============================================================================
-- EPO.SI — Migration 014: Ingredient price history + change traceability
-- ----------------------------------------------------------------------------
-- Before this migration, `ingredients.purchase_price` was silently overwritten
-- on every edit or intake, with no record of what it used to be or when it
-- changed — there was no way to answer "when did coffee go from 10 to 11
-- EUR/kg?". Every stock movement is already logged in `ingredient_movements`
-- (migration 004); this adds a `price` column so a price change can be logged
-- the same way, whether or not it came with a quantity change.
-- Run AFTER 004_ingredients.sql. Idempotent.
-- ============================================================================

ALTER TABLE ingredient_movements ADD COLUMN IF NOT EXISTS price NUMERIC(12,4);

-- `receive_ingredient` now optionally takes the new purchase price and, when
-- given, updates `ingredients.purchase_price` and stamps it onto the same
-- movement row as the quantity change (or its own row, if p_delta = 0 — a
-- pure price edit with no stock movement, e.g. from the ingredient edit
-- modal). Existing callers that don't pass p_price are unaffected.
CREATE OR REPLACE FUNCTION receive_ingredient(
  p_ingredient_id UUID,
  p_delta         NUMERIC,
  p_reason        TEXT DEFAULT 'intake',
  p_note          TEXT DEFAULT NULL,
  p_price         NUMERIC DEFAULT NULL
) RETURNS ingredients
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller UUID;
  v_ing    ingredients%ROWTYPE;
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Nimate pravice.'; END IF;

  UPDATE ingredients
     SET stock_quantity = stock_quantity + p_delta,
         purchase_price = COALESCE(p_price, purchase_price)
   WHERE id = p_ingredient_id AND tenant_id = v_caller
  RETURNING * INTO v_ing;
  IF NOT FOUND THEN RAISE EXCEPTION 'Surovina ne obstaja.'; END IF;

  INSERT INTO ingredient_movements (tenant_id, ingredient_id, delta, reason, note, price)
  VALUES (v_caller, p_ingredient_id, p_delta, COALESCE(p_reason, 'intake'), p_note, p_price);

  RETURN v_ing;
END;
$$;
