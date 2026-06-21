-- ============================================================================
-- EPO.SI — Migration 005: Skupni in deljeni račun (obračun po postavkah)
-- ----------------------------------------------------------------------------
-- Run AFTER 002_invoices.sql. Idempotent.
--
-- Omogoča:
--   - SKUPNI račun za mizo (vse neobračunane postavke vseh rund),
--   - DELJENI / DELNI račun (natakar izbere posamezne postavke),
--   brez dvojnega obračuna (order_items.invoice_id označi že obračunane).
-- ============================================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_order_items_invoice ON order_items(invoice_id);

-- ============================================================================
-- RPC: issue_invoice_for_items — obračuna IZBRANE postavke (po id-jih) v en
-- račun. Uporablja se za skupni (vse postavke mize) in deljeni (podmnožica)
-- račun. Atomarno: dodeli zaporedno številko, izračuna DDV, posnetek, in
-- označi postavke z invoice_id (da se ne obračunajo dvakrat).
-- ============================================================================
CREATE OR REPLACE FUNCTION issue_invoice_for_items(
  p_item_ids       UUID[],
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
  v_count     INT;
  v_inv       invoices%ROWTYPE;
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Nimate pravice za izdajo računa.'; END IF;

  -- Samo neobračunane postavke tega lokala.
  SELECT COUNT(*) INTO v_count
  FROM order_items
  WHERE id = ANY(p_item_ids) AND tenant_id = v_caller AND invoice_id IS NULL;
  IF v_count = 0 THEN RAISE EXCEPTION 'Ni neobračunanih postavk.'; END IF;

  SELECT * INTO v_tenant FROM tenants WHERE id = v_caller;
  SELECT full_name INTO v_op_name FROM profiles WHERE id = auth.uid();

  -- Reprezentativno naročilo + miza (za povezavo na računu).
  SELECT o.id, o.table_id INTO v_order_id, v_table_id
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = ANY(p_item_ids) AND oi.tenant_id = v_caller AND oi.invoice_id IS NULL
  LIMIT 1;

  -- Postavke računa.
  WITH lines AS (
    SELECT oi.item_name AS name, oi.quantity AS qty, oi.item_price AS unit_price,
           CASE WHEN v_tenant.vat_registered
                THEN COALESCE(mi.vat_rate, v_tenant.default_vat_rate, 22) ELSE 0 END AS rate,
           ROUND(oi.item_price * oi.quantity, 2) AS gross
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE oi.id = ANY(p_item_ids) AND oi.tenant_id = v_caller AND oi.invoice_id IS NULL
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'name', name, 'qty', qty, 'unit_price', unit_price,
           'vat_rate', rate, 'line_total', gross)), '[]'::jsonb)
  INTO v_items FROM lines;

  IF v_tenant.vat_registered THEN
    WITH lines AS (
      SELECT COALESCE(mi.vat_rate, v_tenant.default_vat_rate, 22) AS rate,
             ROUND(oi.item_price * oi.quantity, 2) AS gross
      FROM order_items oi
      LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
      WHERE oi.id = ANY(p_item_ids) AND oi.tenant_id = v_caller AND oi.invoice_id IS NULL
    ),
    grouped AS (
      SELECT rate, SUM(gross) AS gross,
             ROUND(SUM(gross) / (1 + rate/100.0), 2) AS base,
             ROUND(SUM(gross) - SUM(gross) / (1 + rate/100.0), 2) AS vat
      FROM lines GROUP BY rate
    )
    SELECT COALESCE(SUM(base),0), COALESCE(SUM(vat),0), COALESCE(SUM(gross),0),
           COALESCE(jsonb_agg(jsonb_build_object('rate',rate,'base',base,'vat',vat) ORDER BY rate), '[]'::jsonb)
    INTO v_net, v_vat, v_gross, v_breakdown FROM grouped;
  ELSE
    SELECT COALESCE(SUM(ROUND(oi.item_price*oi.quantity,2)),0)
    INTO v_gross FROM order_items oi
    WHERE oi.id = ANY(p_item_ids) AND oi.tenant_id = v_caller AND oi.invoice_id IS NULL;
    v_net := v_gross; v_vat := 0; v_breakdown := '[]'::jsonb;
  END IF;

  -- Zaporedna številka.
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
    v_tenant.premise_label, v_tenant.device_label, v_op_name, COALESCE(p_payment_method, 'gotovina'),
    COALESCE(v_tenant.business_name, v_tenant.name), v_tenant.address, v_tenant.tax_number, v_tenant.vat_registered,
    v_tenant.currency, v_net, v_vat, v_gross, v_breakdown, v_items, COALESCE(v_tenant.fiscal_enabled, false)
  ) RETURNING * INTO v_inv;

  -- Označi obračunane postavke.
  UPDATE order_items
     SET invoice_id = v_inv.id
   WHERE id = ANY(p_item_ids) AND tenant_id = v_caller AND invoice_id IS NULL;

  RETURN v_inv;
END;
$$;

-- ============================================================================
-- Posodobljen issue_invoice(order_id): obračuna VSE neobračunane postavke enega
-- naročila prek issue_invoice_for_items (in s tem označi invoice_id). Če ni
-- neobračunanih postavk, vrne zadnji obstoječi račun (idempotentno).
-- ============================================================================
CREATE OR REPLACE FUNCTION issue_invoice(
  p_order_id       UUID,
  p_payment_method TEXT DEFAULT 'gotovina'
) RETURNS invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller UUID;
  v_ids    UUID[];
  v_inv    invoices%ROWTYPE;
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Nimate pravice za izdajo računa.'; END IF;

  SELECT array_agg(id) INTO v_ids
  FROM order_items
  WHERE order_id = p_order_id AND tenant_id = v_caller AND invoice_id IS NULL;

  IF v_ids IS NULL THEN
    SELECT * INTO v_inv FROM invoices WHERE order_id = p_order_id ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN RETURN v_inv; END IF;
    RAISE EXCEPTION 'Ni postavk za obračun.';
  END IF;

  SELECT * INTO v_inv FROM issue_invoice_for_items(v_ids, p_payment_method);
  RETURN v_inv;
END;
$$;
