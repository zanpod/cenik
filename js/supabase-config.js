// ============================================================================
// EPO.SI — Supabase client configuration
// ----------------------------------------------------------------------------
// The anon key is PUBLIC by design — Row Level Security protects the data.
// Replace these two values with your own Supabase project credentials.
// (Project Settings → API in the Supabase dashboard.)
// ============================================================================

const SUPABASE_URL = window.EPO_SUPABASE_URL || 'https://mctepmjamozqlihbpmrs.supabase.co';
const SUPABASE_ANON_KEY = window.EPO_SUPABASE_ANON_KEY || 'sb_publishable_PQQcL8a12OPY6_Zxgk3fJg_ULsSwJvZ';

// The public app domain, used when generating QR codes.
// Defaults to the domain the page is currently served from, so QR codes always
// point to wherever the site is actually deployed (admin + menu share a domain).
// Override with window.EPO_APP_DOMAIN only if the menu lives on a different host.
const APP_DOMAIN = window.EPO_APP_DOMAIN ||
  (location.protocol.startsWith('http') ? location.origin : 'https://epocenik.netlify.app');

// Initialise the Supabase client (loaded via CDN as `supabase`).
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});

// Expose globally for the per-page scripts.
window.sb = sb;
window.APP_DOMAIN = APP_DOMAIN;

// Quick guard so misconfiguration produces a clear console message.
if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-ANON-KEY')) {
  console.warn(
    '[EPO.SI] Supabase ni nastavljen. Uredite js/supabase-config.js ' +
    '(ali nastavite window.EPO_SUPABASE_URL / window.EPO_SUPABASE_ANON_KEY).'
  );
}
