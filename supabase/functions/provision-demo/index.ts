// ============================================================================
// EPO.SI — Edge Function: provision-demo
// ----------------------------------------------------------------------------
// Creates or updates a single demo tenant (tenant + categories + items +
// tables + admin user). Operates in TWO modes:
//
//   PUBLIC (self-service) mode — no X-Epo-Auth header, anyone on the public
//   agencijaepo.si/demo page. "email" in the request body is REQUIRED: the
//   password is NEVER returned in the response, it is ONLY sent by email
//   (Resend) to that address — that's the only way the recipient gets it.
//   Rate-limited with a simple limiter (see demo_signup_log, migration 011)
//   against abuse.
//
//   TRUSTED (admin) mode — with a valid X-Epo-Auth header (an EPO.SI login).
//   No rate limit; "email" is optional (if provided, the SAME notification is
//   sent, and additionally the password is returned in the response for
//   immediate on-screen display — see agencijaepo.si/demo, logged-in view).
//
// On FIRST creation, each demo gets its own admin (owner) user account.
// Via RLS (current_tenant_id()) that user sees and edits EXCLUSIVELY their
// own demo tenant (admin panel, tables, orders, settings) — the same
// mechanism that already isolates real customers from each other, so it's
// safe to grant full access. To reset an existing demo's password
// (as an admin), see reset-demo-password.
//
// DEPLOYMENT (Supabase Dashboard, no CLI):
//   1. Supabase Dashboard (cenik project) → Edge Functions → "Deploy a new
//      function" (or "Create a new function").
//   2. Function name: exactly "provision-demo".
//   3. Paste the ENTIRE contents of this file and click "Deploy".
//   4. Secrets (Edge Functions → Secrets) — for sending email:
//        RESEND_API_KEY  — API key from resend.com (can be the same as in the
//                          epo.si project, or a new one — doesn't matter,
//                          anything that works).
//        FROM_EMAIL      — sender address verified on Resend
//                          (e.g. demo@agencijaepo.si).
//      SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Podatki za izdajanje računov — nov lokal (demo ali stranka) jih ima prazne,
// vpiše jih lastnik sam v Nastavitvah. Meni (kategorije, izdelki) ostane.
const EMPTY_BUSINESS_DATA = {
  business_name: null,
  address: null,
  tax_number: null,
  vat_registered: false,
  default_vat_rate: 22,
  premise_label: 'P1',
  device_label: 'BL1',
  fiscal_enabled: false,
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-epo-auth',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// Public (anon) credentials of the EPO.SI portfolio project — the same ones
// that site already exposes in its client-side code (js/supabase-config.js).
// Used ONLY to verify that the X-Epo-Auth token is a valid EPO.SI login.
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
    `Vaš demo »${opts.demoName}« je pripravljen.`,
    '',
    opts.link ? `Povezava za goste (meni): ${opts.link}` : null,
    '',
    'Admin prijava (celoten program — mize/QR kode, naročila v živo, urejanje menija, nastavitve):',
    adminUrl,
    `E-pošta: ${opts.adminEmail}`,
    `Geslo: ${opts.adminPassword}`,
    '',
    'Agencija EPO · agencijaepo.si · 070 517 103',
  ].filter((l) => l !== null).join('\n');

  // Predloga v slogu admin aplikacije (gostilniški slog): krem podlaga, gozdno
  // zelena glava, rdeč poudarek, serifni naslovi, razprte male črke za oznake.
  // Tabelna postavitev in vrstični slogi — tako jo pravilno prikažejo Gmail,
  // Outlook in Apple Mail (zunanji CSS in flex v e-pošti ne delujeta).
  const C = {
    bg: '#f4ecdc', paper: '#fbf7ee', cream2: '#eadfc8', forest: '#22392a', pale: '#c9d6c4',
    red: '#a3302a', ink: '#24211b', muted: '#5b5446', line: '#ddd0b4',
  };
  const FONT = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const SERIF = "Rockwell,'Roboto Slab',Georgia,'Times New Roman',serif";
  const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";
  const label = (t: string) =>
    `<p style="margin:0 0 10px;font:700 11px ${FONT};letter-spacing:2.5px;text-transform:uppercase;color:${C.red}">${t}</p>`;
  const row = (name: string, value: string) => `
          <tr>
            <td style="padding:12px 0;border-top:1px solid ${C.line};font:600 13px ${FONT};color:${C.muted};width:92px;vertical-align:top">${name}</td>
            <td style="padding:12px 0;border-top:1px solid ${C.line};font:15px ${FONT};color:${C.ink};word-break:break-all">${value}</td>
          </tr>`;
  const html = `<!DOCTYPE html>
<html lang="sl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>Vaš demo je pripravljen</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Povezava do menija in podatki za prijavo v administracijo.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}">
  <tr><td align="center" style="padding:36px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:${C.paper};border:1px solid ${C.line};border-radius:6px;overflow:hidden">
      <tr><td style="background:${C.forest};padding:26px 32px 22px">
        <a href="https://agencijaepo.si" style="font:700 26px ${SERIF};color:#ffffff;letter-spacing:-0.3px;text-decoration:none">agencijaepo<span style="color:#e3b3a9">.si</span></a>
        <div style="margin-top:6px;font:600 10px ${FONT};letter-spacing:3px;text-transform:uppercase;color:${C.pale}">Agencija EPO &nbsp;·&nbsp; digitalni meni</div>
      </td></tr>
      <tr><td style="padding:34px 32px 8px">
        ${label('Demo je pripravljen')}
        <h1 style="margin:0 0 14px;font:700 28px/1.2 ${SERIF};color:${C.forest}">Vaš demo »${escHtml(opts.demoName)}«</h1>
        <p style="margin:0 0 24px;font:15px/1.65 ${FONT};color:${C.muted}">Tako bo meni videti vašim gostom. Odprite ga na telefonu – kot da bi skenirali QR kodo na mizi.</p>
        ${opts.link ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${C.red};border-radius:3px">
          <a href="${escHtml(opts.link)}" style="display:inline-block;padding:13px 26px;font:700 15px ${FONT};color:#ffffff;text-decoration:none">Odprite meni za goste</a>
        </td></tr></table>
        <p style="margin:10px 0 0;font:12px ${FONT};color:${C.muted};word-break:break-all"><a href="${escHtml(opts.link)}" style="color:${C.muted}">${escHtml(opts.link)}</a></p>` : ''}
      </td></tr>
      <tr><td style="padding:28px 32px 6px">
        <div style="border-top:2px solid ${C.forest};padding-top:26px">
          ${label('Prijava za osebje')}
          <h2 style="margin:0 0 6px;font:700 20px ${SERIF};color:${C.forest}">Administracija</h2>
          <p style="margin:0 0 12px;font:14px/1.6 ${FONT};color:${C.muted}">Celoten program: mize in QR kode, naročila v živo, urejanje menija, nastavitve.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ${C.line}">
            ${row('Naslov', `<a href="${escHtml(adminUrl)}" style="color:${C.red};font-weight:600;text-decoration:underline">${escHtml(adminUrl)}</a>`)}
            ${row('E-pošta', `<span style="font-weight:600">${escHtml(opts.adminEmail)}</span>`)}
            ${row('Geslo', `<span style="font:700 15px ${MONO};color:${C.forest};background:${C.cream2};padding:3px 8px;border-radius:3px">${escHtml(opts.adminPassword)}</span>`)}
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr><td style="border:1px solid ${C.forest};border-radius:3px">
            <a href="${escHtml(adminUrl)}" style="display:inline-block;padding:10px 20px;font:700 14px ${FONT};color:${C.forest};text-decoration:none">Prijava v administracijo</a>
          </td></tr></table>
          <p style="margin:18px 0 0;font:13px/1.6 ${FONT};color:${C.muted}">Podatke za prijavo shranite. Demo je namenjen preizkusu – naročila v njem niso prava.</p>
        </div>
      </td></tr>
      <tr><td style="padding:28px 32px 30px">
        <div style="background:${C.bg};border-radius:4px;padding:16px 18px;font:13px/1.6 ${FONT};color:${C.muted}">
          Vprašanja? Odgovorite na to sporočilo ali pokličite <a href="tel:+38670517103" style="color:${C.forest};font-weight:600;text-decoration:none">070 517 103</a>.
        </div>
      </td></tr>
      <tr><td style="background:${C.forest};padding:16px 32px;font:12px ${FONT};color:${C.pale}">
        <strong style="color:#ffffff">Agencija EPO</strong> &nbsp;·&nbsp; <a href="https://agencijaepo.si" style="color:#ffffff;font-weight:600;text-decoration:none">agencijaepo.si</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Brez prikaznega imena v FROM_EMAIL dodamo »Agencija EPO«.
      from: FROM_EMAIL.includes('<') ? FROM_EMAIL : `Agencija EPO <${FROM_EMAIL}>`,
      to: [toEmail],
      reply_to: 'info@agencijaepo.si',
      subject: `Vaš demo »${opts.demoName}« je pripravljen – Agencija EPO`,
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
    // 1) Try to authorize against the EPO.SI project — OPTIONAL. A missing or
    // invalid token does not reject the request, it just means "public
    // caller" (stricter rules below: email required, rate-limited, password
    // not returned).
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

    // 2) Rate-limit ONLY public (untrusted) callers.
    if (!isTrusted) {
      // x-forwarded-for is a chain "client, proxy1, proxy2, ...", where each
      // hop only APPENDS to it (never overwrites) — the client can forge
      // their own segment, but the last entry (closest to the server) is
      // added by Supabase's own edge and cannot be forged. So we take the
      // LAST entry, not the first.
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

    // Safeguard: an existing slug that is NOT a demo is never overwritten (likely a real customer).
    const { data: existing, error: exErr } = await admin.from('tenants').select('id, is_demo').eq('slug', slug).maybeSingle();
    if (exErr) return json({ error: `Napaka pri preverjanju obstoječega lokala: ${exErr.message}` }, 500);
    if (existing && !existing.is_demo) {
      return json({ error: `Lokal s slug-om "${slug}" že obstaja in NI označen kot demo — verjetno gre za pravo stranko. Izberite drug slug.` }, 409);
    }

    const { data: tenant, error: tErr } = await admin.from('tenants').upsert(
      {
        slug,
        name,
        primary_color: body.primary_color || '#4a7fe0',
        secondary_color: body.secondary_color || '#7ba3ec',
        logo_url: body.logo_url || null,
        currency: body.currency || '€',
        is_demo: true,
        is_active: true,
        // Podatki za račune vedno prazni: upsert na obstoječem slugu bi
        // sicer obdržal naziv firme, naslov in davčno od prejšnjega demota.
        ...EMPTY_BUSINESS_DATA,
      },
      { onConflict: 'slug' }
    ).select().single();
    if (tErr) return json({ error: `Napaka pri ustvarjanju lokala: ${tErr.message}` }, 500);

    // Replace the whole catalog (safe to re-run — see provision.js for the rationale).
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

    // Ensure at least tableCount tables exist. Existing ones (and their QR
    // tokens) are never deleted — already-distributed QR codes must stay valid.
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

    // Ensure this demo tenant has an admin (owner) user, so the customer can
    // explore the WHOLE admin panel themselves — not just the guest menu.
    // The email is derived from the slug. Public callers get a NEW password
    // on every call (the only way to (re)obtain it — see the sending logic
    // below); trusted callers only get a new password if the account doesn't
    // exist yet.
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

    // Send the email: REQUIRED for public callers (the only way to deliver
    // the password), optional for trusted ones (only if they provided an email).
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
          // For a public caller without email, there's no other way to
          // convey the password — this IS an error they need to see.
          return json({ error: mailErr.message || String(mailErr) }, 502);
        }
        console.error('Sending the email failed (trusted call, continuing):', mailErr);
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
