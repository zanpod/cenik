// ============================================================================
// EPO.SI — Edge Function: delete-demo
// ----------------------------------------------------------------------------
// Izbriše en demo lokal (CASCADE: kategorije, izdelki, mize, naročila, računi).
// Namenjena gumbu "Izbriši" na agencijaepo.si/demo. Briše SAMO lokale z
// is_demo = true, da po nesreči ne izbrišete prave (plačljive) stranke.
//
// NAMESTITEV (Supabase Dashboard, brez CLI): enako kot provision-demo — Edge
// Functions → Deploy a new function → ime "delete-demo" → prilepite to
// datoteko → Deploy.
//
// AVTORIZACIJA: glej provision-demo/index.ts — enak mehanizem (X-Epo-Auth
// preverjen proti EPO.SI projektu).
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

    const { error: delErr } = await admin.from('tenants').delete().eq('id', tenant.id);
    if (delErr) return json({ error: delErr.message }, 500);

    return json({ ok: true, name: tenant.name, slug: tenant.slug });
  } catch (err) {
    console.error(err);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
