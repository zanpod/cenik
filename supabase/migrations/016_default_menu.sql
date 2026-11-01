-- ============================================================================
-- EPO.SI — Migration 016: Osnovni (privzeti) meni za nove lokale
-- ----------------------------------------------------------------------------
-- Run AFTER 015. Idempotent.
--
-- Vsak nov demo, ki ob ustvarjanju ne pošlje svojega menija (javni
-- samopostrežni /demo vedno), dobi ta osnovni meni — 10 izdelkov v štirih
-- skupinah, kot bi ga sestavil izkušen gostinec za tipičen lokal: kava,
-- nekaj hladnega, pivo/vino in malo za pod zob. Lastnik ga v adminu poljubno
-- ureja. Seznam se ureja kar v tej tabeli (brez spreminjanja kode).
--
-- Bere jo samo provision-demo Edge Function (service role); anon in
-- authenticated vloga do nje nimata dostopa (RLS brez policy).
-- ============================================================================

CREATE TABLE IF NOT EXISTS default_menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_name TEXT NOT NULL,
  category_icon TEXT,
  category_sort INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (category_name, name)
);

ALTER TABLE default_menu_items ENABLE ROW LEVEL SECURITY;

INSERT INTO default_menu_items (category_name, category_icon, category_sort, name, description, price, sort_order) VALUES
  ('Tople pijače',          '☕', 0, 'Espresso',                 NULL,                                   1.60, 0),
  ('Tople pijače',          '☕', 0, 'Kava z mlekom',            NULL,                                   1.90, 1),
  ('Tople pijače',          '☕', 0, 'Čaj',                      'Sadni, zeliščni ali črni',             2.20, 2),
  ('Brezalkoholne pijače',  '🥤', 1, 'Domača limonada 0,3 l',    'Sveža limona, meta',                   3.20, 0),
  ('Brezalkoholne pijače',  '🥤', 1, 'Mineralna voda 0,25 l',    NULL,                                   2.30, 1),
  ('Pivo in vino',          '🍺', 2, 'Točeno pivo 0,5 l',        NULL,                                   3.60, 0),
  ('Pivo in vino',          '🍷', 2, 'Hišno vino 1 dl',          'Belo ali rdeče',                       1.80, 1),
  ('Za pod zob',            '🍽️', 3, 'Toast šunka-sir',          'Z domačo omako',                       4.50, 0),
  ('Za pod zob',            '🍽️', 3, 'Narezek',                  'Pršut, sir, olive, domač kruh',        9.50, 1),
  ('Za pod zob',            '🍽️', 3, 'Jabolčni zavitek',         'Postrežen topel',                      3.50, 2)
ON CONFLICT (category_name, name) DO NOTHING;
