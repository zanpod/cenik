-- ============================================================================
-- EPO.SI — Migration 006: Deljenje po količini + vrednotenje zaloge (popis)
-- ----------------------------------------------------------------------------
-- Run AFTER 004_ingredients.sql in 005_invoice_items.sql. Idempotent.
--
-- 1) Surovine dobijo nabavno in prodajno ceno (na osnovno enoto: ml/g/kos).
-- 2) Odpis zaloge se sproži SAMO ob pravi prodaji (NEW.invoice_id IS NULL),
--    da delitev računa po količini (vstavljanje že obračunane vrstice) NE
--    odpiše zaloge še enkrat.
-- 3) issue_invoice_for_quantities: obračun IZBRANIH KOLIČIN posameznih postavk
--    (npr. 1 od 2 kav) — postavko po potrebi razdeli na plačan in neplačan del.
-- ============================================================================

ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(12,4) DEFAULT 0,  -- nabavna cena / osnovno enoto
  ADD COLUMN IF NOT EXISTS sale_price     NUMERIC(12,4) DEFAULT 0;  -- prodajna cena / osnovno enoto

-- Odpis zaloge le ob pravi prodaji (ne ob delitvi računa).
CREATE OR REPLACE FUNCTION decrement_stock()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.menu_item_id IS NOT NULL AND NEW.invoice_id IS NULL THEN
    UPDATE menu_items
       SET stock_quantity = stock_quantity - NEW.quantity
     WHERE id = NEW.menu_item_id AND track_stock = true;

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

-- ============================================================================
-- RPC: issue_invoice_for_quantities — obračun izbranih količin.
-- p_lines = [{ "id": <order_item_id>, "qty": <int> }, ...]
-- ============================================================================
CREATE OR REPLACE FUNCTION issue_invoice_for_quantities(
  p_lines          JSONB,
  p_payment_method TEXT DEFAULT 'gotovina'
) RETURNS invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller    UUID;
  v_tenant    tenants%ROWTYPE;
  v_order_id  UUID;
  v_table_id  UUID;
  v_year      INT := EXTRACT(YEAR FROM now())::INT;
  v_seq       INT;
  v_number    TEXT;
  v_op_name   TEXT;
  v_net       NUMERIC(10,2);
  v_vat       NUMERIC(10,2);
  v_gross     NUMERIC(10,2);
  v_breakdown JSONB;
  v_items     JSONB;
  v_inv       invoices%ROWTYPE;
  r           RECORD;
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Nimate pravice za izdajo računa.'; END IF;
  SELECT * INTO v_tenant FROM tenants WHERE id = v_caller;
  SELECT full_name INTO v_op_name FROM profiles WHERE id = auth.uid();

  -- Zahtevane vrstice, omejene na razpoložljivo (neobračunano) količino.
  CREATE TEMP TABLE _req ON COMMIT DROP AS
  SELECT oi.id,
         LEAST(GREATEST(floor((e.qty)::numeric)::int, 0), oi.quantity) AS qty,
         oi.quantity AS orig_qty, oi.item_name, oi.item_price, oi.menu_item_id,
         oi.order_id, oi.notes,
         CASE WHEN v_tenant.vat_registered
              THEN COALESCE(mi.vat_rate, v_tenant.default_vat_rate, 22) ELSE 0 END AS rate
  FROM (SELECT (x->>'id')::uuid AS id, (x->>'qty')::numeric AS qty
        FROM jsonb_array_elements(p_lines) x) e
  JOIN order_items oi ON oi.id = e.id
  LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
  WHERE oi.tenant_id = v_caller AND oi.invoice_id IS NULL;

  DELETE FROM _req WHERE qty <= 0;
  IF NOT EXISTS (SELECT 1 FROM _req) THEN RAISE EXCEPTION 'Ni postavk za obračun.'; END IF;

  SELECT order_id INTO v_order_id FROM _req LIMIT 1;
  SELECT table_id INTO v_table_id FROM orders WHERE id = v_order_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'name', item_name, 'qty', qty, 'unit_price', item_price,
           'vat_rate', rate, 'line_total', ROUND(item_price * qty, 2))), '[]'::jsonb)
  INTO v_items FROM _req;

  IF v_tenant.vat_registered THEN
    WITH grouped AS (
      SELECT rate, SUM(ROUND(item_price * qty, 2)) AS gross,
             ROUND(SUM(ROUND(item_price * qty, 2)) / (1 + rate/100.0), 2) AS base,
             ROUND(SUM(ROUND(item_price * qty, 2)) - SUM(ROUND(item_price * qty, 2)) / (1 + rate/100.0), 2) AS vat
      FROM _req GROUP BY rate)
    SELECT COALESCE(SUM(base),0), COALESCE(SUM(vat),0), COALESCE(SUM(gross),0),
           COALESCE(jsonb_agg(jsonb_build_object('rate',rate,'base',base,'vat',vat) ORDER BY rate),'[]'::jsonb)
    INTO v_net, v_vat, v_gross, v_breakdown FROM grouped;
  ELSE
    SELECT COALESCE(SUM(ROUND(item_price * qty, 2)),0) INTO v_gross FROM _req;
    v_net := v_gross; v_vat := 0; v_breakdown := '[]'::jsonb;
  END IF;

  INSERT INTO invoice_counters (tenant_id, premise_label, device_label, year, last_seq)
  VALUES (v_caller, v_tenant.premise_label, v_tenant.device_label, v_year, 1)
  ON CONFLICT (tenant_id, premise_label, device_label, year)
  DO UPDATE SET last_seq = invoice_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;
  v_number := v_tenant.premise_label || '-' || v_tenant.device_label || '-' || v_seq;

  INSERT INTO invoices (
    tenant_id, order_id, table_id, invoice_number, seq,
    premise_label, device_label, operator_name, payment_method,
    seller_name, seller_address, seller_tax_number, seller_vat_registered,
    currency, net_total, vat_total, gross_total, vat_breakdown, items, is_fiscal
  ) VALUES (
    v_caller, v_order_id, v_table_id, v_number, v_seq,
    v_tenant.premise_label, v_tenant.device_label, v_op_name, COALESCE(p_payment_method,'gotovina'),
    COALESCE(v_tenant.business_name, v_tenant.name), v_tenant.address, v_tenant.tax_number, v_tenant.vat_registered,
    v_tenant.currency, v_net, v_vat, v_gross, v_breakdown, v_items, COALESCE(v_tenant.fiscal_enabled,false)
  ) RETURNING * INTO v_inv;

  -- Dodeli na postavke: cela vrstica → invoice_id; del → razdeli vrstico.
  FOR r IN SELECT * FROM _req LOOP
    IF r.qty >= r.orig_qty THEN
      UPDATE order_items SET invoice_id = v_inv.id WHERE id = r.id AND invoice_id IS NULL;
    ELSE
      UPDATE order_items SET quantity = r.orig_qty - r.qty WHERE id = r.id;
      INSERT INTO order_items (order_id, menu_item_id, tenant_id, item_name, item_price, quantity, notes, invoice_id)
      VALUES (r.order_id, r.menu_item_id, v_caller, r.item_name, r.item_price, r.qty, r.notes, v_inv.id);
    END IF;
  END LOOP;

  RETURN v_inv;
END;
$$;
