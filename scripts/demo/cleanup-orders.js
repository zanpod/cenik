#!/usr/bin/env node
// ============================================================================
// EPO.SI — Demo provisioning: počisti stara naročila demo lokalov
// ----------------------------------------------------------------------------
// Uporaba:
//   node cleanup-orders.js         -- briše naročila starejša od 24 ur
//   node cleanup-orders.js 6       -- briše naročila starejša od 6 ur
//
// Demo meniji so javni in jih pošiljamo neznancem — testna naročila se ne
// smejo kopičiti v produkciji. Ta skript pokliče SQL funkcijo
// cleanup_demo_orders() (glej supabase/migrations/010_demo_tenants.sql), ki
// briše naročila SAMO lokalov z is_demo = true. Poženite ga ročno občasno,
// ali pa (če imate na Supabase planu na voljo pg_cron) razporedite klic iste
// funkcije neposredno v bazi.
// ============================================================================

import { supabase } from './lib/supabase.js';

const hours = process.argv[2] ? Number(process.argv[2]) : 24;
if (!Number.isFinite(hours) || hours <= 0) {
  console.error('✗ Neveljavno število ur.');
  process.exit(1);
}

async function main() {
  const { data, error } = await supabase.rpc('cleanup_demo_orders', { p_hours: hours });
  if (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  console.log(`✅ Počiščenih naročil demo lokalov (starejših od ${hours} h): ${data}`);
}

main();
