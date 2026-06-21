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
