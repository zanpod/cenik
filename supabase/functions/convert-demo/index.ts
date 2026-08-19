// ============================================================================
// EPO.SI — Edge Function: convert-demo
// ----------------------------------------------------------------------------
// Pretvori demo lokal v pravo (plačljivo) stranko: postavi tenants.is_demo na
// false in po želji zamenja placeholder e-pošto admin računa
// (<slug>@demo.agencijaepo.si) z resničnim naslovom stranke. Geslo ostane
// nespremenjeno (stranka ga že pozna iz demo obdobja).
//
// Po pretvorbi lokal izgine s seznama na agencijaepo.si/demo (ni več
// is_demo) in ga cleanup_demo_orders() ne čisti več — oboje je namerno: zdaj
// je to prava stranka, upravlja se prek cenik admin panela, ne več prek demo
// orodij. delete-demo/reset-demo-password po tej točki nalašč zavrneta
// delovanje na njem (preverjata is_demo = true) — varovalka, da demo orodja
// ne morejo po nesreči izbrisati/ponastaviti prave stranke.
//
// NAMESTITEV (Supabase Dashboard, brez CLI): enako kot ostale — Edge
// Functions → Deploy a new function → ime "convert-demo" → prilepite to
// datoteko → Deploy.
//
// AVTORIZACIJA: samo skrbniško (X-Epo-Auth, enak mehanizem kot delete-demo).
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
