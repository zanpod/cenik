-- ============================================================================
-- EPO.SI — Migration 007: Širina računa (termalni tiskalnik) + logo
-- ----------------------------------------------------------------------------
-- Run AFTER 002_invoices.sql. Idempotent.
-- receipt_width: 58 ali 80 (mm). Logo se uporabi iz tenants.logo_url.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS receipt_width INTEGER DEFAULT 58;  -- 58 | 80 (mm)
