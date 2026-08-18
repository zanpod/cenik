#!/usr/bin/env node
// ============================================================================
// EPO.SI — Demo provisioning: ustvari (ali posodobi) en demo lokal
// ----------------------------------------------------------------------------
// Uporaba:
//   node provision.js <pot-do-json-datoteke>
//   node provision.js examples/kavarna-vahtnca.json
//
// Glej scripts/demo/README.md za obliko vhodne JSON datoteke.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { supabase, APP_DOMAIN } from './lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) {
  fail('Uporaba: node provision.js <pot-do-json-datoteke>\n  Primer: node provision.js examples/kavarna-vahtnca.json');
}

let input;
try {
  input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
} catch (e) {
  fail(`Ne morem prebrati/razčleniti "${inputPath}": ${e.message}`);
}

const { slug, name } = input;
if (!slug || typeof slug !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
  fail('Polje "slug" je obvezno in sme vsebovati le male črke, številke in vezaje (npr. "kavarna-vahtnca").');
}
if (!name || typeof name !== 'string') {
  fail('Polje "name" je obvezno.');
}

const categories = Array.isArray(input.categories) ? input.categories : [];
const tableCount = Number.isInteger(input.tables) && input.tables > 0 ? input.tables : 4;

async function main() {
  console.log(`→ Pripravljam demo za "${name}" (${slug})…`);

  // Varovalka: če slug že obstaja in NI označen kot demo, gre verjetno za
  // pravo (plačljivo) stranko — ne prepišemo je.
  const { data: existing, error: exErr0 } = await supabase
    .from('tenants').select('id, is_demo').eq('slug', slug).maybeSingle();
  if (exErr0) fail(`Napaka pri preverjanju obstoječega lokala: ${exErr0.message}`);
  if (existing && !existing.is_demo) {
    fail(`Lokal s slug-om "${slug}" že obstaja in NI označen kot demo (is_demo=false) — verjetno gre za pravo stranko. Izberite drug slug.`);
  }

  // 1) Upsert tenant (ustvari ali posodobi, vedno označen kot demo).
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .upsert(
      {
        slug,
        name,
        primary_color: input.primary_color || '#6B3FA0',
        secondary_color: input.secondary_color || '#2E4A8B',
        logo_url: input.logo_url || null,
        currency: input.currency || '€',
        is_demo: true,
        is_active: true,
      },
      { onConflict: 'slug' }
    )
    .select()
    .single();
  if (tErr) fail(`Napaka pri ustvarjanju lokala: ${tErr.message}`);

  // 2) Zamenjaj celoten katalog (kategorije + izdelki), da je skript varno
  // ponovno zagnati (npr. po popravku cen v vhodni datoteki). Najprej izbrišemo
  // izdelke (ne kategorij) — menu_items.category_id ob brisanju kategorije samo
  // izgubi povezavo (ON DELETE SET NULL), ne izbriše se, zato bi brez tega
  // koraka ostajali osiroteli izdelki iz prejšnjega zagona.
  const { error: delItemsErr } = await supabase.from('menu_items').delete().eq('tenant_id', tenant.id);
  if (delItemsErr) fail(`Napaka pri brisanju obstoječih izdelkov: ${delItemsErr.message}`);
  const { error: delCatErr } = await supabase.from('categories').delete().eq('tenant_id', tenant.id);
  if (delCatErr) fail(`Napaka pri brisanju obstoječih kategorij: ${delCatErr.message}`);

  let itemCount = 0;
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    if (!cat || !cat.name) continue;

    const { data: catRow, error: catErr } = await supabase
      .from('categories')
      .insert({ tenant_id: tenant.id, name: cat.name, icon: cat.icon || null, sort_order: i })
      .select()
      .single();
    if (catErr) fail(`Napaka pri ustvarjanju kategorije "${cat.name}": ${catErr.message}`);

    const items = Array.isArray(cat.items) ? cat.items : [];
    const rows = items
      .filter((it) => it && it.name && typeof it.price === 'number')
      .map((it, j) => ({
        tenant_id: tenant.id,
        category_id: catRow.id,
        name: it.name,
        description: it.description || null,
        price: it.price,
        sort_order: j,
      }));
    if (rows.length) {
      const { error: itErr } = await supabase.from('menu_items').insert(rows);
      if (itErr) fail(`Napaka pri ustvarjanju izdelkov v kategoriji "${cat.name}": ${itErr.message}`);
      itemCount += rows.length;
    }
  }

  // 3) Poskrbi, da obstaja vsaj `tableCount` miz. Obstoječih miz (in njihovih
  // QR žetonov) ne brišemo niti ne spreminjamo — če je stranka že prejela QR
  // kodo, mora ostati veljavna tudi po ponovnem zagonu skripta.
  const { data: existingTables, error: exErr } = await supabase
    .from('tables').select('*').eq('tenant_id', tenant.id).order('table_number');
  if (exErr) fail(`Napaka pri branju miz: ${exErr.message}`);
  let tables = existingTables || [];
  const maxNum = tables.reduce((m, t) => Math.max(m, t.table_number), 0);
  const toCreate = Math.max(0, tableCount - tables.length);
  if (toCreate > 0) {
    const newRows = Array.from({ length: toCreate }, (_, i) => ({
      tenant_id: tenant.id,
      table_number: maxNum + i + 1,
      label: `Miza ${maxNum + i + 1}`,
    }));
    const { data: created, error: mkErr } = await supabase.from('tables').insert(newRows).select();
    if (mkErr) fail(`Napaka pri ustvarjanju miz: ${mkErr.message}`);
    tables = tables.concat(created);
  }
  tables.sort((a, b) => a.table_number - b.table_number);

  const menuUrl = (t) => `${APP_DOMAIN}/menu/${slug}?table=${t.qr_code_token}`;

  console.log('');
  console.log(`✅ Demo za "${name}" pripravljen (${categories.length} kategorij, ${itemCount} izdelkov, ${tables.length} miz):`);
  tables.forEach((t) => console.log(`   ${t.label || `Miza ${t.table_number}`}: ${menuUrl(t)}`));
  console.log('');
  console.log(`   Glavna povezava za pošiljanje (${tables[0].label || 'Miza 1'}): ${menuUrl(tables[0])}`);

  // 4) QR koda za glavno mizo (PNG, visoka ločljivost za tisk/deljenje).
  const demosDir = path.join(__dirname, 'demos');
  fs.mkdirSync(demosDir, { recursive: true });
  const qrPath = path.join(demosDir, `${slug}-qr.png`);
  await QRCode.toFile(qrPath, menuUrl(tables[0]), { errorCorrectionLevel: 'H', width: 900, margin: 2 });
  console.log('');
  console.log(`   QR koda shranjena: ${path.relative(process.cwd(), qrPath)}`);
  console.log('');
}

main().catch((e) => fail(e.message || String(e)));
