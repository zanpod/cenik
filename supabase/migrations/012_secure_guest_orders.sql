-- ============================================================================
-- EPO.SI — Migration 012: Zavaruj javno naročanje (cena/zaloga na strežniku)
-- ----------------------------------------------------------------------------
-- Run AFTER 011_demo_signup_log.sql. Idempotent.
--
-- TEŽAVA: order_items_public_insert je do zdaj dovolil anonimnim gostom
-- vstaviti POLJUBEN item_name/item_price neposredno (js/menu.js jih je samo
-- prepisal iz brskalnika) — kdorkoli je lahko poslal naročilo s poljubno
-- (npr. 0,01 €) ceno, ali vrinil postavke v naročilo druge mize/lokala, ker
-- politika ni preverjala, da order_id sploh pripada pravemu naročilu.
--
-- REŠITEV: vsa javna naročila zdaj gredo prek submit_guest_order() —
-- SECURITY DEFINER funkcije, ki SAMA prebere pravo ceno/ime/zalogo iz
-- menu_items (odjemalčeva cena/ime se popolnoma ignorirata), preveri lokal +
-- mizo + zalogo, in šele nato vstavi orders + order_items. Neposreden
-- anonimni INSERT na obe tabeli je po tej migraciji ZAPRT — edina pot je ta
-- funkcija. Osebje (authenticated, admin/new-order.js) ni prizadeto —
-- njegove policy (orders_admin_insert / order_items_admin_all) ostajajo.
-- ============================================================================

CREATE OR REPLACE FUNCTION submit_guest_order(
  p_tenant_id UUID,
  p_table_id UUID,
  p_items JSONB,
  p_notes TEXT DEFAULT NULL
) RETURNS orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_total NUMERIC(10,2) := 0;
  v_item JSONB;
  v_menu_item menu_items%ROWTYPE;
  v_qty INT;
  v_variant_name TEXT;
  v_variant JSONB;
  v_line_name TEXT;
  v_line_price NUMERIC(10,2);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id AND is_active = true) THEN
    RAISE EXCEPTION 'Lokal ni na voljo.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tables WHERE id = p_table_id AND tenant_id = p_tenant_id AND is_active = true) THEN
    RAISE EXCEPTION 'Miza ni na voljo.';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Naročilo je prazno.';
  END IF;
  IF jsonb_array_length(p_items) > 100 THEN
    RAISE EXCEPTION 'Preveč postavk v naročilu.';
  END IF;

  INSERT INTO orders (tenant_id, table_id, status, notes, total)
  VALUES (p_tenant_id, p_table_id, 'new', NULLIF(p_notes, ''), 0)
  RETURNING * INTO v_order;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_menu_item FROM menu_items
      WHERE id = NULLIF(v_item->>'menu_item_id', '')::uuid
        AND tenant_id = p_tenant_id
        AND is_available = true;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Izdelek ni (več) na voljo.';
    END IF;

    v_qty := GREATEST(1, LEAST(50, COALESCE((v_item->>'quantity')::int, 1)));
    v_variant_name := NULLIF(v_item->>'variant_name', '');
    v_line_name := v_menu_item.name;
    v_line_price := v_menu_item.price;

    IF v_variant_name IS NOT NULL THEN
      SELECT e INTO v_variant FROM jsonb_array_elements(COALESCE(v_menu_item.variants, '[]'::jsonb)) e
        WHERE e->>'name' = v_variant_name LIMIT 1;
      IF v_variant IS NULL THEN
        RAISE EXCEPTION 'Izbrana varianta ni na voljo.';
      END IF;
      v_line_name := v_menu_item.name || ' – ' || v_variant_name;
      v_line_price := (v_variant->>'price')::numeric;
    END IF;

    IF v_menu_item.track_stock AND v_menu_item.stock_quantity < v_qty THEN
      RAISE EXCEPTION 'Izdelek "%" nima dovolj zaloge.', v_menu_item.name;
    END IF;

    INSERT INTO order_items (order_id, menu_item_id, tenant_id, item_name, item_price, quantity, notes)
    VALUES (v_order.id, v_menu_item.id, p_tenant_id, v_line_name, v_line_price, v_qty, NULLIF(v_item->>'notes', ''));

    v_total := v_total + (v_line_price * v_qty);
  END LOOP;

  UPDATE orders SET total = v_total WHERE id = v_order.id RETURNING * INTO v_order;
  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION submit_guest_order(UUID, UUID, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_guest_order(UUID, UUID, JSONB, TEXT) TO anon;

-- Zapri neposreden anonimni INSERT — edina pot za goste je zdaj zgornja
-- funkcija (SECURITY DEFINER, teče mimo RLS in sama vse preveri).
DROP POLICY IF EXISTS orders_public_insert ON orders;
DROP POLICY IF EXISTS order_items_public_insert ON order_items;
