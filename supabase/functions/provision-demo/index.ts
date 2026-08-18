// ============================================================================
// EPO.SI — Edge Function: provision-demo
// ----------------------------------------------------------------------------
// Ustvari ali posodobi en demo lokal (tenant + kategorije + izdelki + mize).
// Namenjena obrazcu na agencijaepo.si/demo, da lahko prodajni demo pripravite
// v brskalniku, brez terminala (isto logiko kot scripts/demo/provision.js, a
// teče na strežniku).
//
// NAMESTITEV (Supabase Dashboard, brez CLI):
//   1. Supabase Dashboard (cenik projekt) → Edge Functions → "Deploy a new
//      function" (ali "Create a new function").
//   2. Ime funkcije: točno "provision-demo".
//   3. Prilepite CELOTNO vsebino te datoteke in kliknite "Deploy".
//   Nobenih dodatnih skrivnosti (secrets) ni treba nastaviti — SUPABASE_URL in
//   SUPABASE_SERVICE_ROLE_KEY Supabase samodejno priskrbi vsaki Edge Function.
//
// AVTORIZACIJA: klicatelj mora biti prijavljen skrbnik na EPO.SI strani
// (agencijaepo.si/admin ali /demo) — DRUG Supabase projekt kot ta (cenik).
// Ker Supabase-ov API prehod privzeto zahteva, da je Authorization glava
// veljaven JWT ZA TA projekt, epo.si-jev žeton pošljemo v ločeni glavi
// (X-Epo-Auth) in ga tu preverimo neposredno proti epo.si projektu.
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

// Javni (anon) podatki EPO.SI portfolio projekta — isti, ki jih ta stran že
// razkriva v svoji client-side kodi (js/supabase-config.js). Uporabljeni SAMO
// za preverjanje, da je X-Epo-Auth žeton veljavna EPO.SI prijava.
const EPO_SI_URL = Deno.env.get('EPO_SI_SUPABASE_URL') || 'https://ebcwiesqpnthzgowjsjq.supabase.co';
const EPO_SI_ANON_KEY = Deno.env.get('EPO_SI_SUPABASE_ANON_KEY') || 'sb_publishable_BnjJvUIniOhD8hDpfqdaog_XlS02_4s';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // 1) Avtorizacija proti EPO.SI projektu.
    const epoJwt = req.headers.get('X-Epo-Auth') || '';
    const epoSiClient = createClient(EPO_SI_URL, EPO_SI_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${epoJwt}` } },
    });
    const { data: { user } } = await epoSiClient.auth.getUser();
    if (!user) return json({ error: 'Neavtoriziran.' }, 401);

    const body = await req.json();
    const slug = String(body.slug || '');
    const name = String(body.name || '').trim();
    if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      return json({ error: 'Polje "slug" je obvezno in sme vsebovati le male črke, številke in vezaje.' }, 400);
    }
    if (!name) return json({ error: 'Polje "name" je obvezno.' }, 400);

    const categories = Array.isArray(body.categories) ? body.categories : [];
    const tableCount = Number.isInteger(body.tables) && body.tables > 0 ? body.tables : 4;

    // 2) Zapisi v cenik bazo s SERVICE ROLE (mimo RLS) — samodejno priskrbljen.
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Varovalka: obstoječ slug, ki NI demo, se ne prepiše (verjetno prava stranka).
    const { data: existing, error: exErr } = await admin.from('tenants').select('id, is_demo').eq('slug', slug).maybeSingle();
    if (exErr) return json({ error: `Napaka pri preverjanju obstoječega lokala: ${exErr.message}` }, 500);
    if (existing && !existing.is_demo) {
      return json({ error: `Lokal s slug-om "${slug}" že obstaja in NI označen kot demo — verjetno gre za pravo stranko. Izberite drug slug.` }, 409);
    }

    const { data: tenant, error: tErr } = await admin.from('tenants').upsert(
      {
        slug,
        name,
        primary_color: body.primary_color || '#6B3FA0',
        secondary_color: body.secondary_color || '#2E4A8B',
        logo_url: body.logo_url || null,
        currency: body.currency || '€',
        is_demo: true,
        is_active: true,
      },
      { onConflict: 'slug' }
    ).select().single();
    if (tErr) return json({ error: `Napaka pri ustvarjanju lokala: ${tErr.message}` }, 500);

    // Zamenjaj celoten katalog (varno za ponovni zagon — glej provision.js za razlago).
    const { error: delItemsErr } = await admin.from('menu_items').delete().eq('tenant_id', tenant.id);
    if (delItemsErr) return json({ error: `Napaka pri brisanju obstoječih izdelkov: ${delItemsErr.message}` }, 500);
    const { error: delCatErr } = await admin.from('categories').delete().eq('tenant_id', tenant.id);
    if (delCatErr) return json({ error: `Napaka pri brisanju obstoječih kategorij: ${delCatErr.message}` }, 500);

    let itemCount = 0;
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      if (!cat || !cat.name) continue;

      const { data: catRow, error: catErr } = await admin.from('categories')
        .insert({ tenant_id: tenant.id, name: cat.name, icon: cat.icon || null, sort_order: i })
        .select().single();
      if (catErr) return json({ error: `Napaka pri kategoriji "${cat.name}": ${catErr.message}` }, 500);

      const items = Array.isArray(cat.items) ? cat.items : [];
      const rows = items
        .filter((it: any) => it && it.name && typeof it.price === 'number')
        .map((it: any, j: number) => ({
          tenant_id: tenant.id,
          category_id: catRow.id,
          name: it.name,
          description: it.description || null,
          price: it.price,
          sort_order: j,
        }));
      if (rows.length) {
        const { error: itErr } = await admin.from('menu_items').insert(rows);
        if (itErr) return json({ error: `Napaka pri izdelkih v "${cat.name}": ${itErr.message}` }, 500);
        itemCount += rows.length;
      }
    }

    // Poskrbi, da obstaja vsaj tableCount miz. Obstoječih (in njihovih QR
    // žetonov) ne brišemo — poslane QR kode morajo ostati veljavne.
    const { data: existingTables, error: exTErr } = await admin.from('tables').select('*').eq('tenant_id', tenant.id).order('table_number');
    if (exTErr) return json({ error: `Napaka pri branju miz: ${exTErr.message}` }, 500);
    let tables = existingTables || [];
    const maxNum = tables.reduce((m: number, t: any) => Math.max(m, t.table_number), 0);
    const toCreate = Math.max(0, tableCount - tables.length);
    if (toCreate > 0) {
      const newRows = Array.from({ length: toCreate }, (_, i) => ({
        tenant_id: tenant.id,
        table_number: maxNum + i + 1,
        label: `Miza ${maxNum + i + 1}`,
      }));
      const { data: created, error: mkErr } = await admin.from('tables').insert(newRows).select();
      if (mkErr) return json({ error: `Napaka pri ustvarjanju miz: ${mkErr.message}` }, 500);
      tables = tables.concat(created);
    }
    tables.sort((a: any, b: any) => a.table_number - b.table_number);

    return json({ ok: true, tenant, tables, categories: categories.length, items: itemCount });
  } catch (err) {
    console.error(err);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
