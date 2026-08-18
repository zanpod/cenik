#!/usr/bin/env node
// ============================================================================
// EPO.SI — Demo provisioning: izpiši vse trenutne demo lokale
// ----------------------------------------------------------------------------
// Uporaba: node list.js
// ============================================================================

import { supabase, APP_DOMAIN } from './lib/supabase.js';

async function main() {
  const { data, error } = await supabase
    .from('tenants')
    .select('slug, name, created_at, tables(qr_code_token, table_number)')
    .eq('is_demo', true)
    .order('created_at', { ascending: false });
  if (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  if (!data.length) {
    console.log('Trenutno ni demo lokalov.');
    return;
  }

  console.log(`Demo lokali (${data.length}):\n`);
  data.forEach((t) => {
    const firstTable = (t.tables || []).sort((a, b) => a.table_number - b.table_number)[0];
    const link = firstTable ? `${APP_DOMAIN}/menu/${t.slug}?table=${firstTable.qr_code_token}` : '(ni miz)';
    console.log(`• ${t.name}  [${t.slug}]`);
    console.log(`  ustvarjen: ${new Date(t.created_at).toLocaleString('sl-SI')}`);
    console.log(`  povezava:  ${link}`);
    console.log('');
  });
}

main();
