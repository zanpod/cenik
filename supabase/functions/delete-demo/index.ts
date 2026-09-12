// ============================================================================
// EPO.SI — Edge Function: delete-demo
// ----------------------------------------------------------------------------
// Deletes a single demo tenant (CASCADE: categories, items, tables, orders,
// invoices) AND its admin (owner) user account created during provision-demo.
// Backs the "Delete" button on agencijaepo.si/demo. Deletes ONLY tenants with
// is_demo = true, so a real (paying) customer can never be deleted by accident.
//
// DEPLOYMENT (Supabase Dashboard, no CLI): same as provision-demo — Edge
// Functions → Deploy a new function → name "delete-demo" → paste this file →
// Deploy.
//
// AUTHORIZATION: see provision-demo/index.ts — same mechanism (X-Epo-Auth
// verified against the EPO.SI project).
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
    if (!slug) return json({ error: 'Manjka "slug".' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: tenant, error } = await admin.from('tenants').select('*').eq('slug', slug).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!tenant) return json({ error: `Lokal "${slug}" ne obstaja.` }, 404);
    if (!tenant.is_demo) {
      return json({ error: `"${tenant.name}" NI označen kot demo (is_demo=false) — brisanje zavrnjeno.` }, 403);
    }

    // Record the linked admin users BEFORE deleting the tenant (the profiles
    // row is deleted via CASCADE along with the tenant row, but the
    // auth.users entry stays until we delete it explicitly below).
    const { data: profiles } = await admin.from('profiles').select('id').eq('tenant_id', tenant.id);

    const { error: delErr } = await admin.from('tenants').delete().eq('id', tenant.id);
    if (delErr) return json({ error: delErr.message }, 500);

    for (const p of profiles || []) {
      const { error: authDelErr } = await admin.auth.admin.deleteUser(p.id);
      if (authDelErr) console.error('Napaka pri brisanju admin uporabnika', p.id, authDelErr);
    }

    return json({ ok: true, name: tenant.name, slug: tenant.slug });
  } catch (err) {
    console.error(err);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
