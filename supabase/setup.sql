-- ============================================================================
-- EPO.SI — COMBINED SETUP (schema + seed) in correct order.
-- Paste this ENTIRE file into the Supabase SQL Editor and click Run.
-- Do NOT select only part of the text — run the whole thing.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ============================================================================
-- EPO.SI — Digital Menu & Table Ordering System
-- Supabase / PostgreSQL schema, RLS policies, storage, realtime
-- ============================================================================
-- Run this in the Supabase SQL editor (or via the CLI) on a fresh project.
-- It is idempotent-ish: it drops policies before recreating them, so it can be
-- re-run safely during development.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TABLES
-- ----------------------------------------------------------------------------

-- The restaurant/bar/cafe. Each tenant is one business.
CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                    -- "Bar Lipa"
  slug TEXT UNIQUE NOT NULL,             -- "bar-lipa" (used in URL)
  logo_url TEXT,
  primary_color TEXT DEFAULT '#6B3FA0',  -- brand color
  secondary_color TEXT DEFAULT '#2E4A8B',
  currency TEXT DEFAULT '€',
  sound_enabled BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Menu categories (Pijače, Hrana, Sladice, etc.)
CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,                    -- "Tople pijače"
  sort_order INTEGER DEFAULT 0,
  icon TEXT,                             -- emoji like ☕ 🍺 🍕
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Individual items on the menu.
CREATE TABLE IF NOT EXISTS menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,                    -- "Ledeni čaj"
  description TEXT,                      -- "Domači ledeni čaj z limono"
  price DECIMAL(10,2) NOT NULL,          -- 3.50
  image_url TEXT,
  is_available BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  allergens TEXT,                        -- optional allergen info
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Physical tables in the restaurant. Each has a unique QR code.
CREATE TABLE IF NOT EXISTS tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  table_number INTEGER NOT NULL,         -- 1, 2, 3...
  label TEXT,                            -- "Miza 1", "Terasa 3", "VIP"
  qr_code_token TEXT UNIQUE NOT NULL DEFAULT gen_random_uuid()::text,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, table_number)
);

-- Each order placed by a customer from a specific table.
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  table_id UUID REFERENCES tables(id) ON DELETE SET NULL NOT NULL,
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'preparing', 'served', 'cancelled')),
  notes TEXT,                            -- customer notes like "brez sladkorja"
  total DECIMAL(10,2),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Individual items within an order.
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID REFERENCES orders(id) ON DELETE CASCADE NOT NULL,
  menu_item_id UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  item_name TEXT NOT NULL,               -- denormalized so it persists if menu changes
  item_price DECIMAL(10,2) NOT NULL,     -- denormalized
  quantity INTEGER DEFAULT 1,
  notes TEXT,                            -- per-item notes
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Admin users who manage restaurants.
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  full_name TEXT,
  role TEXT DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'staff')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- INDEXES
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_categories_tenant ON categories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_tenant ON menu_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_category ON menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_tables_tenant ON tables(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tables_token ON tables(qr_code_token);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_table ON orders(table_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_tenant ON order_items(tenant_id);

-- ----------------------------------------------------------------------------
-- updated_at trigger for orders
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_set_updated_at ON orders;
CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- HELPER: get the tenant_id of the currently authenticated user.
-- SECURITY DEFINER avoids recursive RLS evaluation on profiles.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID AS $$
  SELECT tenant_id FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ----------------------------------------------------------------------------
-- Auto-create a profile when a new auth user signs up. If the user was invited
-- (metadata carries invited_tenant_id / invited_role), link them to that tenant
-- automatically; otherwise a profile with no tenant is created (an owner that an
-- admin links manually).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, tenant_id, role, full_name)
  VALUES (
    NEW.id,
    NULLIF(NEW.raw_user_meta_data->>'invited_tenant_id', '')::uuid,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'invited_role', ''), 'staff'),
    NEW.raw_user_meta_data->>'full_name'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE tenants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tables      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles    ENABLE ROW LEVEL SECURITY;

-- ---- PROFILES --------------------------------------------------------------
DROP POLICY IF EXISTS profiles_select_own ON profiles;
CREATE POLICY profiles_select_own ON profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS profiles_update_own ON profiles;
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_insert_own ON profiles;
CREATE POLICY profiles_insert_own ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

-- ---- TENANTS ---------------------------------------------------------------
-- Public can read active tenants (needed to load the menu).
DROP POLICY IF EXISTS tenants_public_select ON tenants;
CREATE POLICY tenants_public_select ON tenants
  FOR SELECT TO anon, authenticated
  USING (is_active = true OR id = current_tenant_id());

-- Authenticated users can update their own tenant.
DROP POLICY IF EXISTS tenants_update_own ON tenants;
CREATE POLICY tenants_update_own ON tenants
  FOR UPDATE TO authenticated
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- ---- CATEGORIES ------------------------------------------------------------
DROP POLICY IF EXISTS categories_public_select ON categories;
CREATE POLICY categories_public_select ON categories
  FOR SELECT TO anon, authenticated
  USING (is_active = true OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS categories_admin_all ON categories;
CREATE POLICY categories_admin_all ON categories
  FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---- MENU ITEMS ------------------------------------------------------------
DROP POLICY IF EXISTS menu_items_public_select ON menu_items;
CREATE POLICY menu_items_public_select ON menu_items
  FOR SELECT TO anon, authenticated
  USING (is_available = true OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS menu_items_admin_all ON menu_items;
CREATE POLICY menu_items_admin_all ON menu_items
  FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---- TABLES ----------------------------------------------------------------
-- Public can read tables (to validate a QR token). Token is the secret.
DROP POLICY IF EXISTS tables_public_select ON tables;
CREATE POLICY tables_public_select ON tables
  FOR SELECT TO anon, authenticated
  USING (is_active = true OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tables_admin_all ON tables;
CREATE POLICY tables_admin_all ON tables
  FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ---- ORDERS ----------------------------------------------------------------
-- Anonymous customers may INSERT orders only, for active tenants with a valid
-- active table. They cannot read, update, or delete.
DROP POLICY IF EXISTS orders_public_insert ON orders;
CREATE POLICY orders_public_insert ON orders
  FOR INSERT TO anon
  WITH CHECK (
    EXISTS (SELECT 1 FROM tenants t WHERE t.id = tenant_id AND t.is_active = true)
    AND EXISTS (SELECT 1 FROM tables tb WHERE tb.id = table_id AND tb.tenant_id = orders.tenant_id AND tb.is_active = true)
  );

-- Authenticated staff manage their tenant's orders.
DROP POLICY IF EXISTS orders_admin_select ON orders;
CREATE POLICY orders_admin_select ON orders
  FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS orders_admin_update ON orders;
CREATE POLICY orders_admin_update ON orders
  FOR UPDATE TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS orders_admin_insert ON orders;
CREATE POLICY orders_admin_insert ON orders
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS orders_admin_delete ON orders;
CREATE POLICY orders_admin_delete ON orders
  FOR DELETE TO authenticated
  USING (tenant_id = current_tenant_id());

-- ---- ORDER ITEMS -----------------------------------------------------------
DROP POLICY IF EXISTS order_items_public_insert ON order_items;
CREATE POLICY order_items_public_insert ON order_items
  FOR INSERT TO anon
  WITH CHECK (
    EXISTS (SELECT 1 FROM tenants t WHERE t.id = tenant_id AND t.is_active = true)
  );

DROP POLICY IF EXISTS order_items_admin_select ON order_items;
CREATE POLICY order_items_admin_select ON order_items
  FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS order_items_admin_all ON order_items;
CREATE POLICY order_items_admin_all ON order_items
  FOR ALL TO authenticated
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ============================================================================
-- STORAGE: public bucket for menu images
-- ============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('menu-images', 'menu-images', true)
ON CONFLICT (id) DO NOTHING;

-- Public read access to menu images.
DROP POLICY IF EXISTS "menu-images public read" ON storage.objects;
CREATE POLICY "menu-images public read" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'menu-images');

-- Authenticated users may upload/update/delete menu images.
DROP POLICY IF EXISTS "menu-images auth write" ON storage.objects;
CREATE POLICY "menu-images auth write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'menu-images');

DROP POLICY IF EXISTS "menu-images auth update" ON storage.objects;
CREATE POLICY "menu-images auth update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'menu-images');

DROP POLICY IF EXISTS "menu-images auth delete" ON storage.objects;
CREATE POLICY "menu-images auth delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'menu-images');

-- ============================================================================
-- REALTIME: enable on orders + order_items
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE orders;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'order_items'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE order_items;
  END IF;
END $$;


-- ============================================================================
-- EPO.SI — Seed data for local/testing
-- Run AFTER schema.sql. Creates one demo tenant with categories, items, tables.
-- To link an admin user: create the user in Supabase Auth, then run the
-- profiles INSERT at the bottom with the real auth user id.
-- ============================================================================

-- Demo tenant
INSERT INTO tenants (id, name, slug, primary_color, secondary_color, currency)
VALUES ('11111111-1111-1111-1111-111111111111', 'Bar Lipa', 'bar-lipa', '#6B3FA0', '#2E4A8B', '€')
ON CONFLICT (id) DO NOTHING;

-- Categories
INSERT INTO categories (id, tenant_id, name, icon, sort_order) VALUES
  ('22222222-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Tople pijače', '☕', 0),
  ('22222222-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Hladne pijače', '🥤', 1),
  ('22222222-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Pivo & vino', '🍺', 2),
  ('22222222-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Hrana', '🍕', 3),
  ('22222222-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'Sladice', '🍰', 4)
ON CONFLICT (id) DO NOTHING;

-- Menu items
INSERT INTO menu_items (tenant_id, category_id, name, description, price, sort_order) VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000001', 'Espresso', 'Klasičen espresso', 1.50, 0),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000001', 'Kapučino', 'Espresso z mlečno peno', 2.20, 1),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000001', 'Topla čokolada', 'Gosta domača vroča čokolada', 2.80, 2),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000002', 'Ledeni čaj', 'Domači ledeni čaj z limono', 3.50, 0),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000002', 'Coca-Cola', '0,33 l', 2.50, 1),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000002', 'Sveže stisnjen sok', 'Pomaranča', 3.80, 2),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000003', 'Točeno pivo 0,5 l', 'Union', 3.20, 0),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000003', 'Kozarec vina', 'Hišno belo/rdeče', 3.00, 1),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000004', 'Margarita pica', 'Paradižnik, mozzarella, bazilika', 8.50, 0),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000004', 'Burger Lipa', 'Goveji burger s pomfritom', 11.00, 1),
  ('11111111-1111-1111-1111-111111111111', '22222222-0000-0000-0000-000000000005', 'Tiramisu', 'Domači tiramisu', 4.20, 0)
ON CONFLICT DO NOTHING;

-- Tables (qr_code_token auto-generated; fetch them from the tables table after)
INSERT INTO tables (tenant_id, table_number, label) VALUES
  ('11111111-1111-1111-1111-111111111111', 1, 'Miza 1'),
  ('11111111-1111-1111-1111-111111111111', 2, 'Miza 2'),
  ('11111111-1111-1111-1111-111111111111', 3, 'Terasa 1')
ON CONFLICT (tenant_id, table_number) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Link an admin user (replace <AUTH_USER_ID> with the id from auth.users):
-- ----------------------------------------------------------------------------
-- INSERT INTO profiles (id, tenant_id, full_name, role)
-- VALUES ('<AUTH_USER_ID>', '11111111-1111-1111-1111-111111111111', 'Lastnik', 'owner')
-- ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, role = EXCLUDED.role;


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


-- ============================================================================
-- EPO.SI — Migration 003: Zaloge (inventory) + samodejni odpis
-- ----------------------------------------------------------------------------
-- Run AFTER schema.sql. Idempotent.
--
-- - menu_items dobi sledenje zalogi (track_stock, stock_quantity).
-- - Ob vsaki vstavljeni postavki naročila se zaloga samodejno odpiše
--   (trigger, SECURITY DEFINER → deluje tudi za anonimne QR goste).
-- - Ob preklicu naročila se zaloga vrne nazaj.
-- ============================================================================

ALTER TABLE menu_items
  ADD COLUMN IF NOT EXISTS track_stock    BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS stock_quantity INTEGER DEFAULT 0;

-- ---- Odpis zaloge ob vstavljeni postavki naročila --------------------------
CREATE OR REPLACE FUNCTION decrement_stock()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.menu_item_id IS NOT NULL THEN
    UPDATE menu_items
       SET stock_quantity = stock_quantity - NEW.quantity
     WHERE id = NEW.menu_item_id AND track_stock = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS order_items_decrement_stock ON order_items;
CREATE TRIGGER order_items_decrement_stock
  AFTER INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION decrement_stock();

-- ---- Vrnitev zaloge ob preklicu naročila -----------------------------------
CREATE OR REPLACE FUNCTION restock_on_cancel()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status <> 'cancelled' THEN
    UPDATE menu_items mi
       SET stock_quantity = mi.stock_quantity + oi.quantity
      FROM order_items oi
     WHERE oi.order_id = NEW.id
       AND oi.menu_item_id = mi.id
       AND mi.track_stock = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS orders_restock_on_cancel ON orders;
CREATE TRIGGER orders_restock_on_cancel
  AFTER UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION restock_on_cancel();
