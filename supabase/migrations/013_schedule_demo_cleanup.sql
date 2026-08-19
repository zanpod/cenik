-- ============================================================================
-- EPO.SI — Migration 013: Samodejno urniško čiščenje demo naročil
-- ----------------------------------------------------------------------------
-- Run AFTER 012_secure_guest_orders.sql. Idempotent.
--
-- cleanup_demo_orders() (migracija 010) je do zdaj obstajala, a je nihče ni
-- klical — demo naročila so se kopičila v nedogled, dokler je Zan ni ročno
-- pognal. Ta migracija jo razporedi prek pg_cron, da teče vsako uro sama.
--
-- Če CREATE EXTENSION spodaj odpove zaradi pravic: Supabase Dashboard →
-- Database → Extensions → poiščite "pg_cron" → Enable, nato poženite samo
-- del od "SELECT cron.unschedule..." dalje.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

-- Odstrani prejšnji urnik z istim imenom, če obstaja (varno za ponovni zagon).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cleanup-demo-orders';

-- Vsako uro pobriše naročila demo lokalov, starejša od 24 ur.
SELECT cron.schedule(
  'cleanup-demo-orders',
  '0 * * * *',
  $$SELECT cleanup_demo_orders(24)$$
);
