-- ============================================================================
-- EPO.SI — Migration 009: Storno, davčna operaterja, popusti, plačila/napitnina,
--          pripravljalno mesto (kuhinja/šank), variante, zaščita javnih naročil
-- ----------------------------------------------------------------------------
-- Run AFTER 008_staff_codes.sql. Idempotent.
-- ============================================================================

-- ---- Davčna številka operaterja --------------------------------------------
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tax_number TEXT;

-- ---- Račun: storno, popust, plačila, napitnina -----------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS doc_type             TEXT DEFAULT 'normal',  -- normal | storno
  ADD COLUMN IF NOT EXISTS ref_invoice_id       UUID,
  ADD COLUMN IF NOT EXISTS ref_invoice_number   TEXT,
  ADD COLUMN IF NOT EXISTS voided_by_invoice_id UUID,
  ADD COLUMN IF NOT EXISTS discount_pct         NUMERIC(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount      NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tip_amount           NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_cash          NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_card          NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_other         NUMERIC(10,2) DEFAULT 0;

-- ---- Menu: pripravljalno mesto + variante ----------------------------------
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS prep_station TEXT DEFAULT 'sank',          -- sank | kuhinja | brez
  ADD COLUMN IF NOT EXISTS variants     JSONB DEFAULT '[]'::jsonb;    -- [{name, price}]

-- ---- Operater na računu: dodaj še davčno številko --------------------------
CREATE OR REPLACE FUNCTION fill_invoice_operator()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code TEXT; v_name TEXT; v_tax TEXT;
BEGIN
  IF NEW.operator_code IS NULL AND NEW.operator_tax_no IS NULL THEN
    SELECT staff_code, full_name, tax_number INTO v_code, v_name, v_tax
      FROM profiles WHERE id = auth.uid();
    NEW.operator_code := v_code;
    NEW.operator_tax_no := COALESCE(NEW.operator_tax_no, v_tax);
    IF NEW.operator_name IS NULL THEN NEW.operator_name := v_name; END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- issue_invoice_for_quantities (v2): popust + razdelitev plačila + napitnina
-- ============================================================================
CREATE OR REPLACE FUNCTION issue_invoice_for_quantities(
  p_lines          JSONB,
  p_payment_method TEXT DEFAULT 'gotovina',
  p_discount_pct   NUMERIC DEFAULT 0,
  p_cash           NUMERIC DEFAULT NULL,
  p_card           NUMERIC DEFAULT NULL,
  p_other          NUMERIC DEFAULT NULL,
  p_tip            NUMERIC DEFAULT 0
) RETURNS invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller UUID; v_tenant tenants%ROWTYPE;
  v_order_id UUID; v_table_id UUID;
  v_year INT := EXTRACT(YEAR FROM now())::INT;
  v_seq INT; v_number TEXT; v_op_name TEXT;
  v_disc NUMERIC := GREATEST(0, LEAST(COALESCE(p_discount_pct,0), 100));
  v_full NUMERIC(10,2); v_net NUMERIC(10,2); v_vat NUMERIC(10,2); v_gross NUMERIC(10,2);
  v_breakdown JSONB; v_items JSONB; v_pm TEXT; v_n INT;
  v_cash NUMERIC(10,2); v_card NUMERIC(10,2); v_other NUMERIC(10,2);
  v_inv invoices%ROWTYPE; r RECORD;
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Nimate pravice za izdajo računa.'; END IF;
  SELECT * INTO v_tenant FROM tenants WHERE id = v_caller;
  SELECT full_name INTO v_op_name FROM profiles WHERE id = auth.uid();

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

  SELECT COALESCE(SUM(ROUND(item_price*qty,2)),0) INTO v_full FROM _req;

  IF v_tenant.vat_registered THEN
    WITH grouped AS (
      SELECT rate,
             ROUND(SUM(ROUND(item_price*qty,2)) * (1 - v_disc/100.0), 2) AS dgross
      FROM _req GROUP BY rate
    ), calc AS (
      SELECT rate, dgross,
             ROUND(dgross/(1+rate/100.0),2) AS base,
             dgross - ROUND(dgross/(1+rate/100.0),2) AS vat
      FROM grouped
    )
    SELECT COALESCE(SUM(base),0), COALESCE(SUM(vat),0), COALESCE(SUM(dgross),0),
           COALESCE(jsonb_agg(jsonb_build_object('rate',rate,'base',base,'vat',vat) ORDER BY rate),'[]'::jsonb)
    INTO v_net, v_vat, v_gross, v_breakdown FROM calc;
  ELSE
    v_gross := ROUND(v_full * (1 - v_disc/100.0), 2);
    v_net := v_gross; v_vat := 0; v_breakdown := '[]'::jsonb;
  END IF;

  -- Razdelitev plačila: če ni podana, vse na izbrani način.
  v_cash := COALESCE(p_cash, 0); v_card := COALESCE(p_card, 0); v_other := COALESCE(p_other, 0);
  IF (v_cash + v_card + v_other) = 0 THEN
    IF p_payment_method = 'kartica' THEN v_card := v_gross;
    ELSIF p_payment_method = 'drugo' THEN v_other := v_gross;
    ELSE v_cash := v_gross; END IF;
  END IF;
  v_n := (CASE WHEN v_cash>0 THEN 1 ELSE 0 END) + (CASE WHEN v_card>0 THEN 1 ELSE 0 END) + (CASE WHEN v_other>0 THEN 1 ELSE 0 END);
  v_pm := CASE WHEN v_n > 1 THEN 'mešano'
               WHEN v_card>0 THEN 'kartica' WHEN v_other>0 THEN 'drugo' ELSE 'gotovina' END;

  INSERT INTO invoice_counters (tenant_id, premise_label, device_label, year, last_seq)
  VALUES (v_caller, v_tenant.premise_label, v_tenant.device_label, v_year, 1)
  ON CONFLICT (tenant_id, premise_label, device_label, year)
  DO UPDATE SET last_seq = invoice_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;
  v_number := v_tenant.premise_label || '-' || v_tenant.device_label || '-' || v_seq;

  INSERT INTO invoices (
    tenant_id, order_id, table_id, invoice_number, seq, premise_label, device_label,
    operator_name, payment_method, seller_name, seller_address, seller_tax_number,
    seller_vat_registered, currency, net_total, vat_total, gross_total, vat_breakdown,
    items, is_fiscal, discount_pct, discount_amount, tip_amount, amount_cash, amount_card, amount_other
  ) VALUES (
    v_caller, v_order_id, v_table_id, v_number, v_seq, v_tenant.premise_label, v_tenant.device_label,
    v_op_name, v_pm, COALESCE(v_tenant.business_name, v_tenant.name), v_tenant.address, v_tenant.tax_number,
    v_tenant.vat_registered, v_tenant.currency, v_net, v_vat, v_gross, v_breakdown,
    v_items, COALESCE(v_tenant.fiscal_enabled,false), v_disc, ROUND(v_full - v_gross, 2),
    COALESCE(p_tip,0), v_cash, v_card, v_other
  ) RETURNING * INTO v_inv;

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

-- ============================================================================
-- storno_invoice: stornira (dobropis) celoten račun in znova odpre postavke.
-- ============================================================================
CREATE OR REPLACE FUNCTION storno_invoice(p_invoice_id UUID)
RETURNS invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller UUID; v_tenant tenants%ROWTYPE; o invoices%ROWTYPE;
  v_year INT := EXTRACT(YEAR FROM now())::INT;
  v_seq INT; v_number TEXT; v_op TEXT;
  v_items JSONB; v_breakdown JSONB; v_inv invoices%ROWTYPE;
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Nimate pravice.'; END IF;
  SELECT * INTO o FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR o.tenant_id <> v_caller THEN RAISE EXCEPTION 'Račun ne obstaja.'; END IF;
  IF o.doc_type = 'storno' THEN RAISE EXCEPTION 'Storno računa ni mogoče stornirati.'; END IF;
  IF o.voided_by_invoice_id IS NOT NULL THEN RAISE EXCEPTION 'Račun je že storniran.'; END IF;

  SELECT * INTO v_tenant FROM tenants WHERE id = v_caller;
  SELECT full_name INTO v_op FROM profiles WHERE id = auth.uid();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'name', e->>'name', 'qty', -(e->>'qty')::numeric, 'unit_price', (e->>'unit_price')::numeric,
           'vat_rate', (e->>'vat_rate')::numeric, 'line_total', -(e->>'line_total')::numeric)), '[]'::jsonb)
  INTO v_items FROM jsonb_array_elements(o.items) e;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rate', (e->>'rate')::numeric, 'base', -(e->>'base')::numeric, 'vat', -(e->>'vat')::numeric)), '[]'::jsonb)
  INTO v_breakdown FROM jsonb_array_elements(o.vat_breakdown) e;

  INSERT INTO invoice_counters (tenant_id, premise_label, device_label, year, last_seq)
  VALUES (v_caller, o.premise_label, o.device_label, v_year, 1)
  ON CONFLICT (tenant_id, premise_label, device_label, year)
  DO UPDATE SET last_seq = invoice_counters.last_seq + 1
  RETURNING last_seq INTO v_seq;
  v_number := o.premise_label || '-' || o.device_label || '-' || v_seq;

  INSERT INTO invoices (
    tenant_id, order_id, table_id, invoice_number, seq, premise_label, device_label,
    operator_name, payment_method, seller_name, seller_address, seller_tax_number,
    seller_vat_registered, currency, net_total, vat_total, gross_total, vat_breakdown,
    items, is_fiscal, doc_type, ref_invoice_id, ref_invoice_number
  ) VALUES (
    v_caller, o.order_id, o.table_id, v_number, v_seq, o.premise_label, o.device_label,
    v_op, o.payment_method, o.seller_name, o.seller_address, o.seller_tax_number,
    o.seller_vat_registered, o.currency, -o.net_total, -o.vat_total, -o.gross_total, v_breakdown,
    v_items, o.is_fiscal, 'storno', o.id, o.invoice_number
  ) RETURNING * INTO v_inv;

  UPDATE invoices SET voided_by_invoice_id = v_inv.id WHERE id = o.id;
  -- Postavke znova odpri (miza se po potrebi spet odpre / možen ponovni obračun).
  UPDATE order_items SET invoice_id = NULL WHERE invoice_id = o.id;

  RETURN v_inv;
END;
$$;

-- ============================================================================
-- Zaščita pred zlorabo javnega (anonimnega) naročanja: največ 5 naročil na
-- mizo v 20 sekundah.
-- ============================================================================
CREATE OR REPLACE FUNCTION limit_anon_orders()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT count(*) FROM orders
        WHERE table_id = NEW.table_id AND created_at > now() - interval '20 seconds') >= 5 THEN
    RAISE EXCEPTION 'Preveč naročil v kratkem času. Počakajte trenutek.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_rate_limit ON orders;
CREATE TRIGGER orders_rate_limit
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION limit_anon_orders();
