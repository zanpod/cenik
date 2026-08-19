// ============================================================================
// EPO.SI — Edge Function: provision-demo
// ----------------------------------------------------------------------------
// Ustvari ali posodobi en demo lokal (tenant + kategorije + izdelki + mize +
// admin uporabnik). Deluje v DVEH načinih:
//
//   JAVNI (samopostrežni) način — brez X-Epo-Auth glave, kdorkoli na javni
//   agencijaepo.si/demo strani. OBVEZEN je "email" v telesu zahteve: geslo se
//   NIKOLI ne vrne v odgovoru, ampak SAMO pošlje po e-pošti (Resend) na ta
//   naslov — to je edini način, da ga prejemnik dobi. Omejeno s preprostim
//   rate-limitom (glej demo_signup_log, migracija 011) proti zlorabi.
//
//   ZAUPANJA VREDEN (skrbniški) način — z veljavno X-Epo-Auth glavo (EPO.SI
//   prijava). Brez rate-limita; "email" je neobvezen (če je podan, se pošlje
//   ISTO obvestilo, poleg tega se geslo tudi vrne v odgovoru za takojšen
//   prikaz na zaslonu — glej agencijaepo.si/demo, prijavljeni pogled).
//
// Ob PRVEM ustvarjanju vsak demo dobi svoj admin (owner) uporabniški račun.
// Prek RLS (current_tenant_id()) ta uporabnik vidi in ureja IZKLJUČNO svoj
// demo lokal (admin panel, mize, naročila, nastavitve) — enak mehanizem, ki
// že loči prave stranke med sabo, zato je varno dati poln dostop. Za
// ponastavitev gesla obstoječega demota (skrbniško) glej reset-demo-password.
//
// NAMESTITEV (Supabase Dashboard, brez CLI):
//   1. Supabase Dashboard (cenik projekt) → Edge Functions → "Deploy a new
//      function" (ali "Create a new function").
//   2. Ime funkcije: točno "provision-demo".
//   3. Prilepite CELOTNO vsebino te datoteke in kliknite "Deploy".
//   4. Secrets (Edge Functions → Secrets) — za pošiljanje e-pošte:
//        RESEND_API_KEY  — API ključ iz resend.com (lahko isti kot v epo.si
//                          projektu, ali nov — ni pomembno, kar koli deluje).
//        FROM_EMAIL      — pošiljateljev naslov, preverjen na Resend
//                          (npr. demo@agencijaepo.si).
//      SUPABASE_URL in SUPABASE_SERVICE_ROLE_KEY Supabase priskrbi sam.
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
const APP_DOMAIN = Deno.env.get('DEMO_APP_DOMAIN') || 'https://demo.agencijaepo.si';

function generatePassword(length = 12): string {
  const charset = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => charset[b % charset.length]).join('');
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendCredentialsEmail(toEmail: string, opts: {
  demoName: string; link: string | null; adminEmail: string; adminPassword: string;
}) {
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
  const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'demo@agencijaepo.si';
  if (!RESEND_API_KEY) throw new Error('E-pošta ni nastavljena na strežniku (manjka RESEND_API_KEY) — obrnite se na skrbnika.');

  const adminUrl = `${APP_DOMAIN}/admin`;
  const text = [
    `Vaš demo "${opts.demoName}" je pripravljen!`,
    '',
    opts.link ? `Povezava za goste (meni): ${opts.link}` : null,
    '',
    'Admin prijava (celoten program — mize/QR kode, naročila v živo, urejanje menija, nastavitve):',
    adminUrl,
    `E-pošta: ${opts.adminEmail}`,
    `Geslo: ${opts.adminPassword}`,
  ].filter((l) => l !== null).join('\n');

  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:2rem;background:#0a0a0f;color:#f0f0ff;border-radius:12px">
  <h2 style="color:#4a7fe0;margin-bottom:1rem">Vaš demo "${escHtml(opts.demoName)}" je pripravljen!</h2>
  ${opts.link ? `<p><strong>Povezava za goste (meni):</strong><br><a href="${escHtml(opts.link)}" style="color:#4a7fe0">${escHtml(opts.link)}</a></p>` : ''}
  <hr style="border-color:#222;margin:1.25rem 0">
  <p><strong>Admin prijava</strong> — celoten program: mize/QR kode, naročila v živo, urejanje menija, nastavitve.</p>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:0.4rem 0;color:#aaa;width:100px">Naslov:</td><td><a href="${escHtml(adminUrl)}" style="color:#4a7fe0">${escHtml(adminUrl)}</a></td></tr>
    <tr><td style="padding:0.4rem 0;color:#aaa">E-pošta:</td><td>${escHtml(opts.adminEmail)}</td></tr>
    <tr><td style="padding:0.4rem 0;color:#aaa">Geslo:</td><td><strong>${escHtml(opts.adminPassword)}</strong></td></tr>
  </table>
  <hr style="border-color:#222;margin:1.25rem 0">
  <p style="font-size:0.8rem;color:#666">Demo e-cenik — EPO.SI</p>
</div>`.trim();

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [toEmail],
      subject: `Vaš demo "${opts.demoName}" je pripravljen`,
      text,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Napaka pri pošiljanju e-pošte: ${await res.text()}`);
}

function escHtml(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // 1) Poskusi avtorizirati proti EPO.SI projektu — NEOBVEZNO. Manjkajoč ali
    // neveljaven žeton ne zavrne zahteve, samo pomeni "javni klicatelj"
    // (strožja pravila spodaj: obvezen email, rate-limit, geslo se ne vrne).
    const epoJwt = req.headers.get('X-Epo-Auth') || '';
    let isTrusted = false;
    if (epoJwt) {
      const epoSiClient = createClient(EPO_SI_URL, EPO_SI_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${epoJwt}` } },
      });
      const { data: { user } } = await epoSiClient.auth.getUser();
      isTrusted = !!user;
    }

    const body = await req.json();
    const slug = String(body.slug || '');
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      return json({ error: 'Polje "slug" je obvezno in sme vsebovati le male črke, številke in vezaje.' }, 400);
    }
    if (!name) return json({ error: 'Polje "name" je obvezno.' }, 400);
    if (!isTrusted && !isValidEmail(email)) {
      return json({ error: 'Vnesite veljaven e-poštni naslov — nanj bomo poslali dostop do demota.' }, 400);
    }
    if (email && !isValidEmail(email)) {
      return json({ error: 'E-poštni naslov ni veljaven.' }, 400);
    }

    const categories = Array.isArray(body.categories) ? body.categories : [];
    const tableCount = Number.isInteger(body.tables) && body.tables > 0 ? body.tables : 4;

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // 2) Rate-limit SAMO za javne (nezaupanja vredne) klicatelje.
    if (!isTrusted) {
      // x-forwarded-for je veriga "klient, posrednik1, posrednik2, ...", ki jo
      // vsak vmesni skok samo DOPOLNI (ne prepiše) — klient lahko svoj del
      // ponaredi, zadnji vnos (najbližji strežniku) pa doda Supabase-ov lastni
      // rob in ga ni mogoče ponarediti. Zato vzamemo ZADNJEGA, ne prvega.
      const xff = req.headers.get('x-forwarded-for') || '';
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      const ip = parts.length ? parts[parts.length - 1] : 'unknown';
      const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { count: ipCount, error: ipErr } = await admin
        .from('demo_signup_log').select('*', { count: 'exact', head: true }).eq('ip', ip).gte('created_at', since1h);
      if (ipErr) return json({ error: `Napaka pri preverjanju omejitve: ${ipErr.message}` }, 500);
      if ((ipCount || 0) >= 5) {
        return json({ error: 'Preveč poskusov v kratkem času s tega naslova. Poskusite čez nekaj časa.' }, 429);
      }

      const { count: emailCount, error: emailErr } = await admin
        .from('demo_signup_log').select('*', { count: 'exact', head: true }).eq('email', email).gte('created_at', since24h);
      if (emailErr) return json({ error: `Napaka pri preverjanju omejitve: ${emailErr.message}` }, 500);
      if ((emailCount || 0) >= 3) {
        return json({ error: 'Za ta e-poštni naslov je bilo v zadnjih 24 urah že ustvarjenih preveč demotov.' }, 429);
      }

      const { error: logErr } = await admin.from('demo_signup_log').insert({ slug, email, ip });
      if (logErr) return json({ error: `Napaka pri beleženju: ${logErr.message}` }, 500);
    }

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

    // Poskrbi za admin (owner) uporabnika tega demo lokala, da lahko stranka
    // sama razišče CEL admin panel — ne le gostov meni. E-pošta je
    // determinirana iz slug-a. Javni klicatelji dobijo NOVO geslo ob vsakem
    // klicu (edini način, da ga (znova) dobijo — glej pošiljanje spodaj);
    // zaupanja vredni klicatelji dobijo novo geslo samo, če računa še ni.
    const { data: existingProfile, error: profSelErr } = await admin
      .from('profiles').select('id').eq('tenant_id', tenant.id).eq('role', 'owner').maybeSingle();
    if (profSelErr) return json({ error: `Napaka pri preverjanju admin uporabnika: ${profSelErr.message}` }, 500);

    const adminEmail = `${slug}@demo.agencijaepo.si`;
    let adminPassword: string | null = null;
    const needsNewPassword = !isTrusted || !existingProfile;

    if (needsNewPassword) {
      adminPassword = generatePassword();
      if (existingProfile) {
        const { error: updErr } = await admin.auth.admin.updateUserById(existingProfile.id, { password: adminPassword });
        if (updErr) return json({ error: `Napaka pri posodabljanju admin uporabnika: ${updErr.message}` }, 500);
      } else {
        const { data: createdUser, error: userErr } = await admin.auth.admin.createUser({
          email: adminEmail,
          password: adminPassword,
          email_confirm: true,
          user_metadata: { full_name: `${name} (demo)` },
        });
        if (userErr) return json({ error: `Napaka pri ustvarjanju admin uporabnika: ${userErr.message}` }, 500);

        const { error: profErr } = await admin.from('profiles').upsert({
          id: createdUser.user!.id,
          tenant_id: tenant.id,
          role: 'owner',
          full_name: `${name} (demo)`,
        });
        if (profErr) return json({ error: `Napaka pri povezovanju admin uporabnika: ${profErr.message}` }, 500);
      }
    }

    // Pošlji e-pošto: OBVEZNO za javne klicatelje (edini način dostave gesla),
    // neobvezno za zaupanja vredne (samo če so email podali).
    let emailed = false;
    const shouldEmail = adminPassword && (!isTrusted || email);
    if (shouldEmail) {
      const mainLink = tables[0] ? `${APP_DOMAIN}/menu/${slug}?table=${tables[0].qr_code_token}` : null;
      try {
        await sendCredentialsEmail(email || adminEmail, {
          demoName: name, link: mainLink, adminEmail, adminPassword: adminPassword!,
        });
        emailed = true;
      } catch (mailErr: any) {
        if (!isTrusted) {
          // Javnemu klicatelju brez e-pošte ne moremo povedati gesla na noben
          // drug način — to JE napaka, ki jo mora videti.
          return json({ error: mailErr.message || String(mailErr) }, 502);
        }
        console.error('Pošiljanje e-pošte ni uspelo (skrbniški klic, nadaljujem):', mailErr);
      }
    }

    return json({
      ok: true,
      tenant,
      tables,
      categories: categories.length,
      items: itemCount,
      admin_email: adminEmail,
      admin_password: isTrusted ? adminPassword : null,
      admin_is_new: !existingProfile,
      emailed,
    });
  } catch (err) {
    console.error(err);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
