// ============================================================================
// EPO.SI — Edge Function: convert-demo
// ----------------------------------------------------------------------------
// Converts a demo tenant into a real (paying) customer: sets tenants.is_demo
// to false and optionally replaces the placeholder admin account email
// (<slug>@demo.agencijaepo.si) with the customer's real address. The
// password stays unchanged (the customer already knows it from the demo
// period).
//
// After conversion, the tenant disappears from the list on
// agencijaepo.si/demo (no longer is_demo) and cleanup_demo_orders() no
// longer cleans it up — both intentional: it's now a real customer, managed
// through the cenik admin panel, no longer through demo tooling.
// delete-demo/reset-demo-password deliberately refuse to act on it from this
// point on (they check is_demo = true) — a safeguard so the demo tools can
// never accidentally delete/reset a real customer.
//
// DEPLOYMENT (Supabase Dashboard, no CLI): same as the others — Edge
// Functions → Deploy a new function → name "convert-demo" → paste this file →
// Deploy.
//
// AUTHORIZATION: admin-only (X-Epo-Auth, same mechanism as delete-demo).
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-epo-auth',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

const EPO_SI_URL = Deno.env.get('EPO_SI_SUPABASE_URL') || 'https://ebcwiesqpnthzgowjsjq.supabase.co';
const EPO_SI_ANON_KEY = Deno.env.get('EPO_SI_SUPABASE_ANON_KEY') || 'sb_publishable_BnjJvUIniOhD8hDpfqdaog_XlS02_4s';

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const epoJwt = req.headers.get('X-Epo-Auth') || '';
    const epoSiClient = createClient(EPO_SI_URL, EPO_SI_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${epoJwt}` } },
    });
    const { data: { user } } = await epoSiClient.auth.getUser();
    if (!user) return json({ error: 'Neavtoriziran.' }, 401);

    const body = await req.json();
    const slug = String(body.slug || '');
    const newEmail = String(body.new_email || '').trim();
    if (!slug) return json({ error: 'Manjka "slug".' }, 400);
    if (newEmail && !isValidEmail(newEmail)) return json({ error: 'E-poštni naslov ni veljaven.' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: tenant, error: tErr } = await admin.from('tenants').select('*').eq('slug', slug).maybeSingle();
    if (tErr) return json({ error: tErr.message }, 500);
    if (!tenant) return json({ error: `Lokal "${slug}" ne obstaja.` }, 404);
    if (!tenant.is_demo) return json({ error: `"${tenant.name}" je že prava stranka (ni demo).` }, 409);

    const { error: updTenantErr } = await admin.from('tenants').update({ is_demo: false }).eq('id', tenant.id);
    if (updTenantErr) return json({ error: updTenantErr.message }, 500);

    let emailUpdated = false;
    if (newEmail) {
      const { data: profile, error: profErr } = await admin
        .from('profiles').select('id').eq('tenant_id', tenant.id).eq('role', 'owner').maybeSingle();
      if (profErr) return json({ error: profErr.message }, 500);
      if (profile) {
        const { error: authErr } = await admin.auth.admin.updateUserById(profile.id, {
          email: newEmail, email_confirm: true,
        });
        if (authErr) return json({ error: `Lokal je pretvorjen, a e-pošte ni bilo mogoče zamenjati: ${authErr.message}` }, 500);
        emailUpdated = true;
      }
    }

    return json({ ok: true, name: tenant.name, slug: tenant.slug, email_updated: emailUpdated, admin_email: emailUpdated ? newEmail : null });
  } catch (err) {
    console.error(err);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
