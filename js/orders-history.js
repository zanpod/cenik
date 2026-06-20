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
      '<button class="btn btn-sm" id="export-csv">⬇ Izvozi CSV</button>';
    document.getElementById('export-csv').addEventListener('click', exportCsv);

    const { data: tbs } = await sb.from('tables').select('*').eq('tenant_id', tenant.id).order('table_number');
    (tbs || []).forEach((t) => { tablesById[t.id] = t; });

    renderControls(tbs || []);
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
      <div id="results"></div>`;
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

  document.addEventListener('DOMContentLoaded', init);
})();
