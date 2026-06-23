// ============================================================================
// EPO.SI — Order history (filter by date/table/status, daily totals, CSV)
// ============================================================================

(function () {
  let tenant = null;
  let tablesById = {};
  let rows = [];

  async function init() {
    const ctx = await AdminShell.init('orders', 'Zgodovina naročil');
    if (!ctx) return;
    tenant = ctx.tenant;
    document.getElementById('header-actions').innerHTML =
      '<button class="btn btn-sm" id="z-report">📊 Z-poročilo (dan)</button>' +
      '<button class="btn btn-sm" id="export-csv">⬇ Izvozi CSV</button>';
    document.getElementById('export-csv').addEventListener('click', exportCsv);
    document.getElementById('z-report').addEventListener('click', zReport);

    const { data: tbs } = await sb.from('tables').select('*').eq('tenant_id', tenant.id).order('table_number');
    (tbs || []).forEach((t) => { tablesById[t.id] = t; });

    renderControls(tbs || []);
    window.addEventListener('epo:invoiced', load);
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('f-from').value = today;
    document.getElementById('f-to').value = today;
    await load();
  }

  function renderControls(tbs) {
    document.getElementById('page-content').innerHTML = `
      <div class="card glass" style="margin-bottom:18px">
        <div class="row wrap">
          <div class="field" style="margin:0"><label>Od</label><input class="input" type="date" id="f-from"/></div>
          <div class="field" style="margin:0"><label>Do</label><input class="input" type="date" id="f-to"/></div>
          <div class="field" style="margin:0"><label>Miza</label>
            <select class="select" id="f-table"><option value="">Vse</option>
              ${tbs.map((t) => `<option value="${t.id}">${esc(t.label || 'Miza ' + t.table_number)}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0"><label>Status</label>
            <select class="select" id="f-status">
              <option value="">Vsi</option>
              <option value="new">Novo</option>
              <option value="preparing">V pripravi</option>
              <option value="served">Postreženo</option>
              <option value="cancelled">Preklicano</option>
            </select>
          </div>
          <div class="field" style="margin:0;align-self:flex-end"><button class="btn btn-primary" id="apply">Uporabi</button></div>
        </div>
      </div>
      <div class="stats-row" id="stats"></div>
      <div id="results"></div>
      <h2 style="margin-top:24px">Izdani računi</h2>
      <div id="inv-results"></div>`;
    document.getElementById('apply').addEventListener('click', load);
  }

  async function load() {
    const from = document.getElementById('f-from').value;
    const to = document.getElementById('f-to').value;
    const tableId = document.getElementById('f-table').value;
    const status = document.getElementById('f-status').value;

    let q = sb.from('orders').select('*, order_items(*)')
      .eq('tenant_id', tenant.id).order('created_at', { ascending: false });
    if (from) q = q.gte('created_at', new Date(from + 'T00:00:00').toISOString());
    if (to) q = q.lte('created_at', new Date(to + 'T23:59:59').toISOString());
    if (tableId) q = q.eq('table_id', tableId);
    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) { console.error(error); toast('Napaka pri nalaganju.', 'error'); return; }
    rows = (data || []).map((o) => ({ ...o, items: o.order_items || [] }));
    renderStats();
    renderResults();
    loadInvoices(from, to, tableId);
  }

  async function loadInvoices(from, to, tableId) {
    let q = sb.from('invoices').select('*').eq('tenant_id', tenant.id).order('issued_at', { ascending: false });
    if (from) q = q.gte('issued_at', new Date(from + 'T00:00:00').toISOString());
    if (to) q = q.lte('issued_at', new Date(to + 'T23:59:59').toISOString());
    if (tableId) q = q.eq('table_id', tableId);
    const { data, error } = await q;
    const host = document.getElementById('inv-results');
    if (error) { host.innerHTML = `<p class="muted">Računov ni mogoče naložiti (${esc(error.message)}). Ste zagnali migracije?</p>`; return; }
    const invs = data || [];
    if (!invs.length) { host.innerHTML = '<p class="muted">Ni izdanih računov za izbrane filtre.</p>'; return; }
    host.innerHTML = `
      <div class="card glass" style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Št. računa</th><th>Čas</th><th>Plačilo</th><th class="r">Znesek</th><th></th></tr></thead>
          <tbody>${invs.map((v) => `
            <tr>
              <td><strong>${esc(v.invoice_number)}</strong>${v.doc_type === 'storno' ? ' <span class="badge badge-cancelled">STORNO</span>' : ''}${v.voided_by_invoice_id ? ' <span class="muted">storniran</span>' : ''}</td>
              <td>${formatDateTime(v.issued_at)}</td>
              <td>${esc(v.payment_method || '')}</td>
              <td class="r"><strong>${formatPrice(v.gross_total, tenant.currency)}</strong></td>
              <td class="r"><button class="btn btn-sm" data-inv="${v.id}">Odpri / Storno</button></td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;
    host.querySelectorAll('[data-inv]').forEach((b) =>
      b.addEventListener('click', () => Invoice.openInvoice(b.dataset.inv)));
  }

  function renderStats() {
    const valid = rows.filter((o) => o.status !== 'cancelled');
    const revenue = valid.reduce((s, o) => s + Number(o.total || 0), 0);
    document.getElementById('stats').innerHTML = `
      <div class="stat-card glass"><div class="stat-value">${rows.length}</div><div class="stat-label">Naročil skupaj</div></div>
      <div class="stat-card glass"><div class="stat-value">${valid.length}</div><div class="stat-label">Veljavnih (brez preklicanih)</div></div>
      <div class="stat-card glass"><div class="stat-value">${formatPrice(revenue, tenant.currency)}</div><div class="stat-label">Promet</div></div>`;
  }

  function renderResults() {
    const host = document.getElementById('results');
    if (!rows.length) {
      host.innerHTML = '<div class="empty-state"><div class="emoji">🧾</div><p>Ni naročil za izbrane filtre.</p></div>';
      return;
    }
    host.innerHTML = `
      <div class="card glass" style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Čas</th><th>Miza</th><th>Izdelki</th><th>Status</th><th>Skupaj</th><th></th></tr></thead>
          <tbody>${rows.map(rowHtml).join('')}</tbody>
        </table>
      </div>`;
    wireInvoiceButtons();
  }

  function rowHtml(o) {
    const t = tablesById[o.table_id];
    const label = t ? (t.label || `Miza ${t.table_number}`) : 'Miza ?';
    const items = o.items.map((i) => `${i.quantity}× ${esc(i.item_name)}`).join(', ');
    const invBtn = o.status !== 'cancelled'
      ? `<button class="btn btn-sm" data-invoice="${o.id}" data-label="${esc(label)}">🧾 Račun</button>` : '';
    return `<tr>
      <td>${formatDateTime(o.created_at)}</td>
      <td>${esc(label)}</td>
      <td>${items}${o.notes ? `<div class="muted" style="font-size:.82rem">📝 ${esc(o.notes)}</div>` : ''}</td>
      <td><span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span></td>
      <td><strong>${formatPrice(o.total, tenant.currency)}</strong></td>
      <td>${invBtn}</td>
    </tr>`;
  }

  function wireInvoiceButtons() {
    document.querySelectorAll('[data-invoice]').forEach((btn) => {
      btn.addEventListener('click', () => Invoice.open({ id: btn.dataset.invoice }, btn.dataset.label));
    });
  }

  function exportCsv() {
    if (!rows.length) return toast('Ni podatkov za izvoz.', 'error');
    const header = ['Datum in čas', 'Miza', 'Status', 'Izdelki', 'Opomba', 'Skupaj'];
    const lines = rows.map((o) => {
      const t = tablesById[o.table_id];
      const label = t ? (t.label || `Miza ${t.table_number}`) : 'Miza ?';
      const items = o.items.map((i) => `${i.quantity}x ${i.item_name}`).join('; ');
      return [formatDateTime(o.created_at), label, STATUS_LABELS[o.status].replace(/[^\p{L} ]/gu, '').trim(),
        items, o.notes || '', Number(o.total || 0).toFixed(2)]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',');
    });
    const csv = '﻿' + [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `narocila-${tenant.slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- Z-poročilo: dnevni zaključek prometa iz izdanih računov --------------
  async function zReport() {
    const day = document.getElementById('f-from').value || new Date().toISOString().slice(0, 10);
    const from = new Date(day + 'T00:00:00').toISOString();
    const to = new Date(day + 'T23:59:59').toISOString();
    const { data, error } = await sb.from('invoices').select('*')
      .eq('tenant_id', tenant.id).gte('issued_at', from).lte('issued_at', to)
      .order('seq');
    if (error) { console.error(error); toast('Napaka pri nalaganju računov.', 'error'); return; }
    const invs = data || [];
    if (!invs.length) { toast('Za izbrani dan ni računov.', 'error'); return; }

    const cur = tenant.currency || '€';
    let net = 0, vat = 0, gross = 0, cash = 0, card = 0, other = 0, tip = 0, normal = 0, storno = 0;
    const vatByRate = {};
    invs.forEach((v) => {
      net += +v.net_total; vat += +v.vat_total; gross += +v.gross_total;
      cash += +(v.amount_cash || 0); card += +(v.amount_card || 0); other += +(v.amount_other || 0);
      tip += +(v.tip_amount || 0);
      if (v.doc_type === 'storno') storno++; else normal++;
      (v.vat_breakdown || []).forEach((b) => {
        const r = Number(b.rate).toFixed(1);
        vatByRate[r] = vatByRate[r] || { base: 0, vat: 0 };
        vatByRate[r].base += +b.base; vatByRate[r].vat += +b.vat;
      });
    });
    const money = (n) => Number(n).toFixed(2).replace('.', ',') + ' ' + cur;
    const vatRows = Object.keys(vatByRate).sort().map((r) =>
      `<tr><td>${r}%</td><td class="r">${money(vatByRate[r].base)}</td><td class="r">${money(vatByRate[r].vat)}</td></tr>`).join('');

    const html = `<!DOCTYPE html><html lang="sl"><head><meta charset="utf-8"><title>Z-poročilo ${day}</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#000;padding:24px;max-width:520px}
        h1{margin:0} .sub{color:#555;margin-bottom:16px}
        table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
        td,th{border:1px solid #ccc;padding:6px 8px}.r{text-align:right}
        .big{font-size:18px;font-weight:700}
      </style></head><body onload="window.print()">
      <h1>Z-poročilo (dnevni promet)</h1>
      <div class="sub">${esc(tenant.business_name || tenant.name)} — ${day}</div>
      <table>
        <tr><td>Število računov</td><td class="r">${normal}${storno ? ' (+' + storno + ' storno)' : ''}</td></tr>
        <tr><td>Osnova (neto)</td><td class="r">${money(net)}</td></tr>
        <tr><td>DDV skupaj</td><td class="r">${money(vat)}</td></tr>
        <tr><td class="big">Promet (bruto)</td><td class="r big">${money(gross)}</td></tr>
      </table>
      ${vatRows ? `<table><thead><tr><th>Stopnja</th><th class="r">Osnova</th><th class="r">DDV</th></tr></thead><tbody>${vatRows}</tbody></table>` : ''}
      <table>
        <tr><td>Gotovina</td><td class="r">${money(cash)}</td></tr>
        <tr><td>Kartica</td><td class="r">${money(card)}</td></tr>
        <tr><td>Drugo</td><td class="r">${money(other)}</td></tr>
        <tr><td>Napitnina</td><td class="r">${money(tip)}</td></tr>
      </table>
      <p class="sub">Izpisano: ${new Date().toLocaleString('sl-SI', { timeZone: 'Europe/Ljubljana' })}</p>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast('Brskalnik je blokiral okno za tisk.', 'error'); return; }
    w.document.write(html); w.document.close();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
