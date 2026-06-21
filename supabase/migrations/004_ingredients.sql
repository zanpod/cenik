-- ============================================================================
-- EPO.SI — Migration 004: Surovine (sestavine), recepture, gibanje zaloge
-- ----------------------------------------------------------------------------
-- Run AFTER 003_inventory.sql. Idempotent.
--
-- Vodja lokala lahko:
--   - vodi surovine (kava, mleko ...) z enoto in zalogo,
--   - vsakemu izdelku določi recepturo (npr. kava z mlekom = 8 g kave + 10 ml
--     mleka), ki se ob prodaji samodejno odpiše iz zaloge surovin,
--   - beleži prevzem (intake) surovin.
-- Vse gibanje (prodaja/preklic/prevzem/popravek) se beleži v ingredient_movements.
-- ============================================================================

-- ---- Surovine --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingredients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  name           TEXT NOT NULL,                 -- "Kava", "Mleko"
  unit           TEXT DEFAULT 'kos',            -- g, ml, kos, l, kg
  stock_quantity NUMERIC(12,3) DEFAULT 0,
  low_threshold  NUMERIC(12,3) DEFAULT 0,       -- opozorilo o nizki zalogi
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ---- Receptura (poraba surovin na 1 prodan kos izdelka) ---------------------
CREATE TABLE IF NOT EXISTS item_ingredients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  menu_item_id  UUID REFERENCES menu_items(id) ON DELETE CASCADE NOT NULL,
  ingredient_id UUID REFERENCES ingredients(id) ON DELETE CASCADE NOT NULL,
  quantity      NUMERIC(12,3) NOT NULL DEFAULT 0,   -- npr. 8 (g) ali 10 (ml)
  UNIQUE (menu_item_id, ingredient_id)
);

-- ---- Dnevnik gibanja zaloge surovin ----------------------------------------
CREATE TABLE IF NOT EXISTS ingredient_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  ingredient_id UUID REFERENCES ingredients(id) ON DELETE CASCADE,
  delta         NUMERIC(12,3) NOT NULL,         -- + prevzem, − poraba
  reason        TEXT NOT NULL,                  -- intake|sale|cancel|adjust
  order_id      UUID REFERENCES orders(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingredients_tenant ON ingredients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_item_ingredients_item ON item_ingredients(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_ing_moves_tenant ON ingredient_movements(tenant_id, created_at);

-- ---- RLS (samo prijavljeno osebje svojega lokala) --------------------------
ALTER TABLE ingredients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_ingredients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingredient_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingredients_admin_all ON ingredients;
CREATE POLICY ingredients_admin_all ON ingredients FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS item_ingredients_admin_all ON item_ingredients;
CREATE POLICY item_ingredients_admin_all ON item_ingredients FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS ing_moves_admin_all ON ingredient_movements;
CREATE POLICY ing_moves_admin_all ON ingredient_movements FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- ============================================================================
-- Odpis zaloge ob prodaji — RAZŠIRJENO: poleg končnega izdelka (track_stock)
-- odpiše tudi surovine po recepturi in zabeleži gibanje. SECURITY DEFINER, da
-- deluje tudi za anonimna QR naročila.
-- ============================================================================
CREATE OR REPLACE FUNCTION decrement_stock()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.menu_item_id IS NOT NULL THEN
    -- končni izdelek (npr. ustekleničena pijača)
    UPDATE menu_items
       SET stock_quantity = stock_quantity - NEW.quantity
     WHERE id = NEW.menu_item_id AND track_stock = true;

    -- surovine po recepturi
    UPDATE ingredients i
       SET stock_quantity = i.stock_quantity - (ii.quantity * NEW.quantity)
      FROM item_ingredients ii
     WHERE ii.menu_item_id = NEW.menu_item_id AND ii.ingredient_id = i.id;

    INSERT INTO ingredient_movements (tenant_id, ingredient_id, delta, reason, order_id)
    SELECT NEW.tenant_id, ii.ingredient_id, -(ii.quantity * NEW.quantity), 'sale', NEW.order_id
      FROM item_ingredients ii
     WHERE ii.menu_item_id = NEW.menu_item_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Vrnitev zaloge ob preklicu — vključno s surovinami.
CREATE OR REPLACE FUNCTION restock_on_cancel()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE menu_items mi
       SET stock_quantity = mi.stock_quantity + oi.quantity
      FROM order_items oi
     WHERE oi.order_id = NEW.id AND oi.menu_item_id = mi.id AND mi.track_stock = true;

    UPDATE ingredients i
       SET stock_quantity = i.stock_quantity + (ii.quantity * oi.quantity)
      FROM order_items oi
      JOIN item_ingredients ii ON ii.menu_item_id = oi.menu_item_id
     WHERE oi.order_id = NEW.id AND ii.ingredient_id = i.id;

    INSERT INTO ingredient_movements (tenant_id, ingredient_id, delta, reason, order_id)
    SELECT NEW.tenant_id, ii.ingredient_id, (ii.quantity * oi.quantity), 'cancel', NEW.id
      FROM order_items oi
      JOIN item_ingredients ii ON ii.menu_item_id = oi.menu_item_id
     WHERE oi.order_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================================
-- RPC: prevzem / popravek zaloge surovine (atomarno + dnevnik).
-- ============================================================================
CREATE OR REPLACE FUNCTION receive_ingredient(
  p_ingredient_id UUID,
  p_delta         NUMERIC,
  p_reason        TEXT DEFAULT 'intake',
  p_note          TEXT DEFAULT NULL
) RETURNS ingredients
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller UUID;
  v_ing    ingredients%ROWTYPE;
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Nimate pravice.'; END IF;

  UPDATE ingredients
     SET stock_quantity = stock_quantity + p_delta
   WHERE id = p_ingredient_id AND tenant_id = v_caller
  RETURNING * INTO v_ing;
  IF NOT FOUND THEN RAISE EXCEPTION 'Surovina ne obstaja.'; END IF;

  INSERT INTO ingredient_movements (tenant_id, ingredient_id, delta, reason, note)
  VALUES (v_caller, p_ingredient_id, p_delta, COALESCE(p_reason, 'intake'), p_note);

  RETURN v_ing;
END;
$$;
