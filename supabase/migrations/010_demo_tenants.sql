-- ============================================================================
-- EPO.SI — Migration 010: Demo lokali (prodajni demoji)
-- ----------------------------------------------------------------------------
-- Run AFTER 009_pos_final.sql. Idempotent.
--
-- - tenants.is_demo: loči prodajne demo lokale (poslane potencialnim strankam)
--   od pravih, plačljivih strank. Provisioning orodje (scripts/demo/) ustvarja
--   in briše samo lokale z is_demo = true.
-- - cleanup_demo_orders(): pobriše stara naročila demo lokalov, da se ne
--   kopičijo v produkcijski bazi. Računi (invoices) ostanejo nedotaknjeni
--   (order_id gre na NULL prek obstoječega ON DELETE SET NULL) — demo lokali
--   nimajo omogočene fiskalizacije, zato to ni izguba davčnih podatkov.
--   Pokliče se ročno (glej scripts/demo/cleanup-orders.js) ali razporedi prek
--   pg_cron, če je razšerjitev na voljo na vašem Supabase planu:
--     select cron.schedule('cleanup-demo-orders', '0 * * * *',
--       $$select cleanup_demo_orders(24)$$);
-- ============================================================================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_tenants_is_demo ON tenants(is_demo) WHERE is_demo = true;

CREATE OR REPLACE FUNCTION cleanup_demo_orders(p_hours INTEGER DEFAULT 24)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
  DELETE FROM orders o
  USING tenants t
  WHERE o.tenant_id = t.id
    AND t.is_demo = true
    AND o.created_at < now() - (p_hours || ' hours')::interval;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION cleanup_demo_orders(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_demo_orders(INTEGER) TO service_role;
