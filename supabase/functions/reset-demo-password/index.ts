// ============================================================================
// EPO.SI — Edge Function: reset-demo-password
// ----------------------------------------------------------------------------
// Ponastavi geslo obstoječega demo lokala (admin/owner uporabnik, ustvarjen
// ob prvem provision-demo klicu). Uporabno, če ste geslo izgubili, ali če
// isti demo pošiljate novi stranki. Vrne novo geslo — prikaže se SAMO enkrat,
// v odgovoru te funkcije.
//
// NAMESTITEV (Supabase Dashboard, brez CLI): enako kot provision-demo — Edge
// Functions → Deploy a new function → ime "reset-demo-password" → prilepite
// to datoteko → Deploy.
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

function generatePassword(length = 12): string {
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => charset[b % charset.length]).join('');
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
    if (!slug) return json({ error: 'Manjka "slug".' }, 400);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: tenant, error: tErr } = await admin.from('tenants').select('id, name, is_demo').eq('slug', slug).maybeSingle();
    if (tErr) return json({ error: tErr.message }, 500);
    if (!tenant) return json({ error: `Lokal "${slug}" ne obstaja.` }, 404);
    if (!tenant.is_demo) return json({ error: `"${tenant.name}" ni demo lokal.` }, 403);

    const { data: profile, error: pErr } = await admin
      .from('profiles').select('id').eq('tenant_id', tenant.id).eq('role', 'owner').maybeSingle();
    if (pErr) return json({ error: pErr.message }, 500);
    if (!profile) {
      return json({ error: 'Ta demo še nima admin uporabnika — znova zaženite "Nov demo" z istim slug-om, da ga ustvari.' }, 404);
    }

    const newPassword = generatePassword();
    const { error: updErr } = await admin.auth.admin.updateUserById(profile.id, { password: newPassword });
    if (updErr) return json({ error: updErr.message }, 500);

    return json({ ok: true, admin_email: `${slug}@demo.agencijaepo.si`, admin_password: newPassword });
  } catch (err) {
    console.error(err);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
