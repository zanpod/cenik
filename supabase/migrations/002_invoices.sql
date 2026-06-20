-- ============================================================================
-- EPO.SI — Migration 002: Računi (invoicing) — SLO zakonodaja, TESTNI način
-- ----------------------------------------------------------------------------
-- Run AFTER schema.sql (and 001/seed). Idempotent.
--
-- Pokriva obvezne elemente računa po ZDDV-1 in strukturo po ZDavPR
-- (zaporedno številčenje P{prostor}-{naprava}-{št}, operater, mesto za
-- ZOI/EOR/QR). DAVČNO POTRJEVANJE (FURS) JE IZKLOPLJENO (fiscal_enabled=false):
-- računi so označeni kot TESTNI / NI DAVČNO POTRJEN, dokler se ne aktivira
-- realna FURS integracija (certifikat + REST/SOAP klic za ZOI/EOR).
-- ============================================================================

-- ---- Tenant: fiskalne / izdajateljske nastavitve ---------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_name    TEXT,                       -- polni naziv firme
  ADD COLUMN IF NOT EXISTS address          TEXT,                       -- naslov sedeža
  ADD COLUMN IF NOT EXISTS tax_number       TEXT,                       -- davčna številka
  ADD COLUMN IF NOT EXISTS vat_registered   BOOLEAN DEFAULT false,      -- zavezanec za DDV?
  ADD COLUMN IF NOT EXISTS default_vat_rate NUMERIC(5,2) DEFAULT 22.00, -- privzeta stopnja DDV
  ADD COLUMN IF NOT EXISTS premise_label    TEXT DEFAULT 'P1',          -- oznaka poslovnega prostora
  ADD COLUMN IF NOT EXISTS device_label     TEXT DEFAULT 'BL1',         -- oznaka elektronske naprave (blagajne)
  ADD COLUMN IF NOT EXISTS fiscal_enabled   BOOLEAN DEFAULT false;      -- FURS davčno potrjevanje (test=false)

-- ---- Menu item: stopnja DDV (null => privzeta stopnja lokala) ---------------
ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS vat_rate NUMERIC(5,2);

-- ---- Števec računov (zaporedno številčenje brez vrzeli) ---------------------
CREATE TABLE IF NOT EXISTS invoice_counters (
  tenant_id     UUID REFERENCES tenants(id) ON DELETE CASCADE,
  premise_label TEXT NOT NULL,
  device_label  TEXT NOT NULL,
  year          INTEGER NOT NULL,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, premise_label, device_label, year)
);

-- ---- Izdani računi (nespremenljiv posnetek) --------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  order_id              UUID REFERENCES orders(id) ON DELETE SET NULL,
  table_id              UUID REFERENCES tables(id) ON DELETE SET NULL,
  invoice_number        TEXT NOT NULL,            -- npr. P1-BL1-12
  seq                   INTEGER NOT NULL,
  premise_label         TEXT NOT NULL,
  device_label          TEXT NOT NULL,
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_name         TEXT,
  operator_tax_no       TEXT,
  payment_method        TEXT DEFAULT 'gotovina',  -- gotovina|kartica|drugo
  -- posnetek izdajatelja (denormaliziran, da je račun nespremenljiv)
  seller_name           TEXT,
  seller_address        TEXT,
  seller_tax_number     TEXT,
  seller_vat_registered BOOLEAN,
  currency              TEXT DEFAULT '€',
  net_total             NUMERIC(10,2) NOT NULL,   -- osnova (brez DDV)
  vat_total             NUMERIC(10,2) NOT NULL,   -- skupaj DDV
  gross_total           NUMERIC(10,2) NOT NULL,   -- za plačilo
  vat_breakdown         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{rate, base, vat}]
  items                 JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{name, qty, unit_price, vat_rate, line_total}]
  is_fiscal             BOOLEAN DEFAULT false,    -- davčno potrjen? (test=false)
  zoi                   TEXT,                     -- zaščitna oznaka izdajatelja (FURS) — null v testu
  eor                   TEXT,                     -- enkratna identifikacijska oznaka (FURS) — null v testu
  note                  TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_order  ON invoices(order_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, created_at);

-- ---- RLS -------------------------------------------------------------------
ALTER TABLE invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_admin_all ON invoices;
CREATE POLICY invoices_admin_all ON invoices
  FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS counters_admin_select ON invoice_counters;
CREATE POLICY counters_admin_select ON invoice_counters
  FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

-- ============================================================================
-- RPC: issue_invoice — atomarno dodeli zaporedno številko, izračuna DDV po
-- stopnjah iz naročila in shrani nespremenljiv račun. SECURITY DEFINER, da
-- je številčenje zanesljivo in brez vrzeli (zahteva ZDavPR).
-- ============================================================================
CREATE OR REPLACE FUNCTION issue_invoice(
  p_order_id       UUID,
  p_payment_method TEXT DEFAULT 'gotovina'
) RETURNS invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_caller    UUID;
  v_tenant    tenants%ROWTYPE;
  v_order     orders%ROWTYPE;
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
BEGIN
  v_caller := current_tenant_id();
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Nimate pravice za izdajo računa.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND OR v_order.tenant_id <> v_caller THEN
    RAISE EXCEPTION 'Naročilo ne obstaja ali ni vaše.';
  END IF;

  -- Že obstoječ račun za to naročilo => vrni ga (idempotentno, brez podvojitev).
  SELECT * INTO v_inv FROM invoices WHERE order_id = p_order_id ORDER BY created_at LIMIT 1;
  IF FOUND THEN RETURN v_inv; END IF;

  SELECT * INTO v_tenant FROM tenants WHERE id = v_caller;
  SELECT full_name INTO v_op_name FROM profiles WHERE id = auth.uid();

  -- Postavke računa z efektivno stopnjo DDV.
  WITH lines AS (
    SELECT oi.item_name AS name,
           oi.quantity  AS qty,
           oi.item_price AS unit_price,
           CASE WHEN v_tenant.vat_registered
                THEN COALESCE(mi.vat_rate, v_tenant.default_vat_rate, 22)
                ELSE 0 END AS rate,
           ROUND(oi.item_price * oi.quantity, 2) AS gross
    FROM order_items oi
    LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
    WHERE oi.order_id = p_order_id
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
      WHERE oi.order_id = p_order_id
    ),
    grouped AS (
      SELECT rate,
             SUM(gross)                                        AS gross,
             ROUND(SUM(gross) / (1 + rate/100.0), 2)           AS base,
             ROUND(SUM(gross) - SUM(gross) / (1 + rate/100.0), 2) AS vat
      FROM lines GROUP BY rate
    )
    SELECT COALESCE(SUM(base),0), COALESCE(SUM(vat),0), COALESCE(SUM(gross),0),
           COALESCE(jsonb_agg(jsonb_build_object('rate',rate,'base',base,'vat',vat) ORDER BY rate), '[]'::jsonb)
    INTO v_net, v_vat, v_gross, v_breakdown FROM grouped;
  ELSE
    SELECT COALESCE(SUM(ROUND(oi.item_price*oi.quantity,2)),0)
    INTO v_gross FROM order_items oi WHERE oi.order_id = p_order_id;
    v_net := v_gross; v_vat := 0; v_breakdown := '[]'::jsonb;
  END IF;

  -- Atomarno zaporedno številčenje (P{prostor}-{naprava}-{št} na leto).
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
    v_caller, p_order_id, v_order.table_id, v_number, v_seq,
    v_tenant.premise_label, v_tenant.device_label, v_op_name, COALESCE(p_payment_method, 'gotovina'),
    COALESCE(v_tenant.business_name, v_tenant.name), v_tenant.address, v_tenant.tax_number, v_tenant.vat_registered,
    v_tenant.currency, v_net, v_vat, v_gross, v_breakdown, v_items, COALESCE(v_tenant.fiscal_enabled, false)
  ) RETURNING * INTO v_inv;

  RETURN v_inv;
END;
$$;
