-- ============================================================================
-- EPO.SI — Migration 008: Natakar (šifra) + vloge + operater na računu
-- ----------------------------------------------------------------------------
-- Run AFTER 002_invoices.sql in schema.sql. Idempotent.
--
-- - profiles.staff_code: šifra natakarja.
-- - invoices.operator_code: šifra operaterja na računu (samodejno ob izdaji).
-- - owner/admin lahko ureja profile osebja svojega lokala.
-- ============================================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS staff_code TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS operator_code TEXT;

-- Vloga trenutnega uporabnika (SECURITY DEFINER → brez rekurzije na profiles).
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

-- Owner/admin lahko ureja (in bere) profile osebja svojega lokala.
DROP POLICY IF EXISTS profiles_update_tenant ON profiles;
CREATE POLICY profiles_update_tenant ON profiles
  FOR UPDATE TO authenticated
  USING (tenant_id = current_tenant_id() AND current_user_role() IN ('owner','admin'))
  WITH CHECK (tenant_id = current_tenant_id());

-- Samodejno zapiše šifro (in ime) operaterja na račun iz profila izdajatelja.
CREATE OR REPLACE FUNCTION fill_invoice_operator()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code TEXT; v_name TEXT;
BEGIN
  IF NEW.operator_code IS NULL THEN
    SELECT staff_code, full_name INTO v_code, v_name FROM profiles WHERE id = auth.uid();
    NEW.operator_code := v_code;
    IF NEW.operator_name IS NULL THEN NEW.operator_name := v_name; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_fill_operator ON invoices;
CREATE TRIGGER invoices_fill_operator
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION fill_invoice_operator();

-- Povabljeni uporabnik: prevzemi tudi šifro natakarja iz metapodatkov.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, tenant_id, role, full_name, staff_code)
  VALUES (
    NEW.id,
    NULLIF(NEW.raw_user_meta_data->>'invited_tenant_id', '')::uuid,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'invited_role', ''), 'staff'),
    NEW.raw_user_meta_data->>'full_name',
    NULLIF(NEW.raw_user_meta_data->>'invited_staff_code', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
