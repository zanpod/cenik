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
