// ============================================================================
// EPO.SI — Demo provisioning: skupna Supabase povezava (service role)
// ----------------------------------------------------------------------------
// Teče LOKALNO v Node, nikoli v brskalniku. Service role ključ obide RLS, zato
// mora ostati zunaj frontend kode — bere se iz scripts/demo/.env (gitignored).
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const APP_DOMAIN = (process.env.APP_DOMAIN || 'https://demo.agencijaepo.si').replace(/\/+$/, '');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('✗ Manjkata SUPABASE_URL in/ali SUPABASE_SERVICE_ROLE_KEY.');
  console.error('  Kopirajte scripts/demo/.env.example v scripts/demo/.env in izpolnite vrednosti.');
  process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
