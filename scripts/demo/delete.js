#!/usr/bin/env node
// ============================================================================
// EPO.SI — Demo provisioning: izbriši en demo lokal (CASCADE)
// ----------------------------------------------------------------------------
// Uporaba:
//   node delete.js <slug>          -- vpraša za potrditev
//   node delete.js <slug> --yes    -- brez vprašanja (za skripte)
//
// Briše SAMO lokale z is_demo = true, da se izognemo nesreči pri pravih
// (plačljivih) strankah. Brisanje tenants vrstice se prek FK ON DELETE CASCADE
// razširi na categories, menu_items, tables, orders, order_items, invoices,
// invoice_counters in profiles tega lokala.
// ============================================================================

import readline from 'node:readline';
import { supabase } from './lib/supabase.js';

const slug = process.argv[2];
const force = process.argv.includes('--yes') || process.argv.includes('-y');

if (!slug) {
  console.error('Uporaba: node delete.js <slug> [--yes]');
  process.exit(1);
}

function confirm(question) {
  if (force) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^(da|d|y|yes)$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const { data: tenant, error } = await supabase.from('tenants').select('*').eq('slug', slug).maybeSingle();
  if (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  if (!tenant) {
    console.error(`✗ Lokal s slug-om "${slug}" ne obstaja.`);
    process.exit(1);
  }
  if (!tenant.is_demo) {
    console.error(`✗ "${tenant.name}" [${slug}] NI označen kot demo (is_demo=false).`);
    console.error('  To orodje briše samo demo lokale, da po nesreči ne izbrišete prave stranke.');
    console.error('  Če ga res želite izbrisati, to storite ročno v Supabase nadzorni plošči.');
    process.exit(1);
  }

  const ok = await confirm(
    `Izbrišem demo "${tenant.name}" [${slug}] in VSE njegove podatke (kategorije, izdelki, mize, naročila)? (da/ne) `
  );
  if (!ok) {
    console.log('Preklicano.');
    return;
  }

  const { error: delErr } = await supabase.from('tenants').delete().eq('id', tenant.id);
  if (delErr) {
    console.error(`✗ ${delErr.message}`);
    process.exit(1);
  }
  console.log(`✅ Demo "${tenant.name}" [${slug}] izbrisan.`);
}

main();
