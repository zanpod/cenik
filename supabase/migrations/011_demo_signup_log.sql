-- ============================================================================
-- EPO.SI — Migration 011: Dnevnik javnih demo prijav (samopostrežni /demo)
-- ----------------------------------------------------------------------------
-- Run AFTER 010_demo_tenants.sql. Idempotent.
--
-- agencijaepo.si/demo je zdaj javen (brez prijave) in dovoljuje SAMOPOSTREŽNO
-- ustvarjanje demota (obiskovalec vnese svoj e-mail, geslo dobi po e-pošti).
-- Ta tabela beleži vsak tak poskus (e-mail + IP + čas), da lahko
-- provision-demo Edge Function omeji zlorabo (preveč demotov v kratkem času
-- z istega e-maila/IP-ja). Dostopa do nje NIMA niti anon niti authenticated
-- vloga — piše/bere samo Edge Function s service role ključem.
-- ============================================================================

CREATE TABLE IF NOT EXISTS demo_signup_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug TEXT NOT NULL,
  email TEXT NOT NULL,
  ip TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_demo_signup_log_email ON demo_signup_log(email, created_at);
CREATE INDEX IF NOT EXISTS idx_demo_signup_log_ip ON demo_signup_log(ip, created_at);

ALTER TABLE demo_signup_log ENABLE ROW LEVEL SECURITY;
-- Namerno brez policy za anon/authenticated — samo service_role (Edge
-- Function) sme brati/pisati; RLS z nič policy že to zavrne privzeto.
