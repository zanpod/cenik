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
