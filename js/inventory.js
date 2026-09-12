// ============================================================================
// EPO.SI — Zaloge: Surovine/blago + Prevzem (intake) + Popis (inventura)
// Osnovna enota je ml / g / kos. Prevzem in popis se vnašata v L / kg / kos in
// se samodejno pretvorita (L→ml, kg→g; kos ostane kos).
// ============================================================================

(function () {
  let tenant = null;
  let ingredients = [];
  let tab = 'surovine';
  let editingId = null;

  const purchaseUnit = (b) => (b === 'ml' ? 'L' : b === 'g' ? 'kg' : 'kos');
  const factor = (b) => (b === 'ml' || b === 'g' ? 1000 : 1);   // base na purchase enoto
  const toBase = (purchaseQty, b) => Number(purchaseQty) * factor(b);
  const toPurchase = (baseQty, b) => Number(baseQty) / factor(b);
  const num = (n) => Number(n || 0).toLocaleString('sl-SI', { maximumFractionDigits: 3 });
  const cur = () => (tenant && tenant.currency) || '€';

  async function init() {
    const ctx = await AdminShell.init('inventory', 'Zaloge');
    if (!ctx) return;
    tenant = ctx.tenant;
    document.getElementById('header-actions').innerHTML =
      '<button class="btn btn-primary btn-sm" id="add-ing">＋ Surovina / blago</button>';
    document.getElementById('add-ing').addEventListener('click', () => openModal());
    document.getElementById('ing-save').addEventListener('click', saveIngredient);
    document.getElementById('ing-unit').addEventListener('change', syncUnitLabels);
    document.getElementById('ing-purchase').addEventListener('input', recalcSuggestedSale);
    document.getElementById('ing-cost-ratio').addEventListener('input', recalcSuggestedSale);
    document.getElementById('ing-use-suggested').addEventListener('click', () => {
      const v = document.getElementById('ing-suggested-sale').value;
      if (v) document.getElementById('ing-sale').value = v;
    });
    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => document.getElementById(b.dataset.close).classList.remove('open')));
    document.getElementById('ing-modal').addEventListener('click', (e) => {
      if (e.target.id === 'ing-modal') e.target.classList.remove('open');
    });
    await load();
  }

  async function load() {
    const { data } = await sb.from('ingredients').select('*').eq('tenant_id', tenant.id).order('name');
    ingredients = data || [];
    renderTabs();
    renderActive();
  }

  function renderTabs() {
    document.getElementById('page-content').innerHTML = `
      <div class="filter-tabs" id="inv-tabs">
        <button class="filter-tab ${tab === 'surovine' ? 'active' : ''}" data-tab="surovine">Surovine / blago</button>
        <button class="filter-tab ${tab === 'prevzem' ? 'active' : ''}" data-tab="prevzem">📥 Prevzem</button>
        <button class="filter-tab ${tab === 'popis' ? 'active' : ''}" data-tab="popis">📋 Popis</button>
      </div>
      <div id="inv-body"></div>`;
    document.querySelectorAll('#inv-tabs .filter-tab').forEach((t) =>
      t.addEventListener('click', () => { tab = t.dataset.tab; renderTabs(); renderActive(); }));
  }

  function renderActive() {
    if (tab === 'surovine') renderSurovine();
    else if (tab === 'prevzem') renderPrevzem();
    else renderPopis();
  }

  // --- Surovine / blago -------------------------------------------------------
  function renderSurovine() {
    const host = document.getElementById('inv-body');
    if (!ingredients.length) { host.innerHTML = '<div class="empty-state"><div class="emoji">📦</div><p>Dodajte surovino ali blago.</p></div>'; return; }
    let nabSkup = 0, prodSkup = 0;
    const rows = ingredients.map((g) => {
      const nab = Number(g.stock_quantity) * Number(g.purchase_price || 0);
      const prod = Number(g.stock_quantity) * Number(g.sale_price || 0);
      nabSkup += nab; prodSkup += prod;
      const pu = purchaseUnit(g.unit);
      return `<tr>
        <td>${esc(g.name)}</td>
        <td>${num(toPurchase(g.stock_quantity, g.unit))} ${pu} <span class="muted">(${num(g.stock_quantity)} ${esc(g.unit)})</span></td>
        <td class="r">${formatPrice(Number(g.purchase_price || 0) * factor(g.unit), cur())}/${pu}</td>
        <td class="r">${formatPrice(Number(g.sale_price || 0) * factor(g.unit), cur())}/${pu}</td>
        <td class="r">${formatPrice(nab, cur())}</td>
        <td class="r">
          <button class="btn btn-sm" data-edit="${g.id}">Uredi</button>
          <button class="btn btn-sm btn-danger" data-del="${g.id}">🗑</button>
        </td>
      </tr>`;
    }).join('');
    host.innerHTML = `
      <div class="card glass" style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Naziv</th><th>Zaloga</th><th class="r">Nabavna</th><th class="r">Prodajna</th><th class="r">Vrednost (nab.)</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td colspan="4"><strong>Skupna vrednost zaloge</strong></td>
            <td class="r"><strong>${formatPrice(nabSkup, cur())}</strong></td><td></td></tr>
          <tr><td colspan="4" class="muted">Prodajna vrednost zaloge</td><td class="r">${formatPrice(prodSkup, cur())}</td><td></td></tr></tfoot>
        </table>
      </div>`;
    host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.edit)));
    host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => del(b.dataset.del)));
  }

  // --- Prevzem (intake) -------------------------------------------------------
  function renderPrevzem() {
    const host = document.getElementById('inv-body');
    if (!ingredients.length) { host.innerHTML = '<div class="empty-state"><div class="emoji">📥</div><p>Najprej dodajte surovine.</p></div>'; return; }
    host.innerHTML = `
      <p class="muted">Vnesite prejete količine (tekočine v <strong>L</strong>, teža v <strong>kg</strong>, ostalo v <strong>kos</strong>). Po želji posodobite nabavno ceno.</p>
      <div class="card glass" style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Naziv</th><th>Trenutna zaloga</th><th>Prejeto</th><th>Nova nabavna cena</th></tr></thead>
          <tbody>${ingredients.map((g) => {
            const pu = purchaseUnit(g.unit);
            return `<tr data-id="${g.id}" data-unit="${g.unit}">
              <td>${esc(g.name)}</td>
              <td>${num(toPurchase(g.stock_quantity, g.unit))} ${pu}</td>
              <td><div class="row" style="gap:6px"><input class="input prevzem-qty" type="number" step="0.001" placeholder="0" style="width:110px" /> <span class="muted">${pu}</span></div></td>
              <td><div class="row" style="gap:6px"><input class="input prevzem-price" type="number" step="0.0001" placeholder="${num(Number(g.purchase_price || 0) * factor(g.unit))}" style="width:120px" /> <span class="muted">${cur()}/${pu}</span></div></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <button class="btn btn-primary" id="prevzem-save" style="margin-top:14px">Shrani prevzem</button>`;
    document.getElementById('prevzem-save').addEventListener('click', savePrevzem);
  }

  async function savePrevzem() {
    const rows = Array.from(document.querySelectorAll('#inv-body tbody tr'));
    const ops = [];
    rows.forEach((row) => {
      const id = row.dataset.id; const unit = row.dataset.unit;
      const qty = parseFloat(row.querySelector('.prevzem-qty').value);
      const price = row.querySelector('.prevzem-price').value;
      if (!isNaN(qty) && qty !== 0) {
        ops.push({ id, unit, deltaBase: toBase(qty, unit), price: price === '' ? null : Number(price) / factor(unit) });
      } else if (price !== '') {
        ops.push({ id, unit, deltaBase: 0, price: Number(price) / factor(unit) });
      }
    });
    if (!ops.length) { toast('Vnesite vsaj eno količino ali ceno.', 'error'); return; }
    const btn = document.getElementById('prevzem-save');
    btn.disabled = true; btn.textContent = 'Shranjujem…';
    try {
      for (const op of ops) {
        if (op.price !== null) await sb.from('ingredients').update({ purchase_price: op.price }).eq('id', op.id);
        if (op.deltaBase !== 0) {
          const { error } = await sb.rpc('receive_ingredient', { p_ingredient_id: op.id, p_delta: op.deltaBase, p_reason: 'intake', p_note: 'prevzem' });
          if (error) throw error;
        }
      }
      toast('Prevzem shranjen.', 'success');
      await load();
    } catch (err) {
      console.error(err); toast('Napaka pri prevzemu: ' + (err.message || ''), 'error', 6000);
    } finally {
      btn.disabled = false; btn.textContent = 'Shrani prevzem';
    }
  }

  // --- Popis (inventura) ------------------------------------------------------
  function renderPopis() {
    const host = document.getElementById('inv-body');
    if (!ingredients.length) { host.innerHTML = '<div class="empty-state"><div class="emoji">📋</div><p>Najprej dodajte surovine.</p></div>'; return; }
    host.innerHTML = `
      <p class="muted">Vnesite <strong>popisano (dejansko) stanje</strong>. Razlika se izračuna sproti. »Uskladi zaloge« nastavi zalogo na popisano in zabeleži popravek.</p>
      <div class="card glass" style="overflow-x:auto">
        <table class="data-table">
          <thead><tr><th>Naziv</th><th class="r">Knjižno</th><th>Popisano</th><th class="r">Razlika</th><th class="r">Vrednost (nab.)</th></tr></thead>
          <tbody>${ingredients.map((g) => {
            const pu = purchaseUnit(g.unit);
            return `<tr data-id="${g.id}" data-unit="${g.unit}" data-book="${g.stock_quantity}" data-pp="${g.purchase_price || 0}" data-sp="${g.sale_price || 0}">
              <td>${esc(g.name)}</td>
              <td class="r book">${num(toPurchase(g.stock_quantity, g.unit))} ${pu}</td>
              <td><div class="row" style="gap:6px"><input class="input popis-qty" type="number" step="0.001" placeholder="0" style="width:110px" /> <span class="muted">${pu}</span></div></td>
              <td class="r diff">—</td>
              <td class="r diffval">—</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <div class="row wrap" style="margin-top:14px">
        <button class="btn" id="popis-pdf">🖨 Izpiši PDF (viški/manki)</button>
        <button class="btn btn-primary" id="popis-sync">Uskladi zaloge</button>
      </div>`;
    document.querySelectorAll('.popis-qty').forEach((inp) => inp.addEventListener('input', () => recalcPopis(inp.closest('tr'))));
    document.getElementById('popis-pdf').addEventListener('click', popisPdf);
    document.getElementById('popis-sync').addEventListener('click', popisSync);
  }

  function recalcPopis(row) {
    const unit = row.dataset.unit;
    const book = Number(row.dataset.book);
    const v = row.querySelector('.popis-qty').value;
    if (v === '') { row.querySelector('.diff').textContent = '—'; row.querySelector('.diffval').textContent = '—'; return; }
    const countedBase = toBase(parseFloat(v) || 0, unit);
    const diffBase = countedBase - book;
    const diffPurchase = toPurchase(diffBase, unit);
    const nab = diffBase * Number(row.dataset.pp);
    const cell = row.querySelector('.diff');
    cell.textContent = `${diffBase > 0 ? '+' : ''}${num(diffPurchase)} ${purchaseUnit(unit)}`;
    cell.style.color = diffBase < 0 ? 'var(--danger)' : diffBase > 0 ? 'var(--success)' : '';
    row.querySelector('.diffval').textContent = formatPrice(nab, cur());
  }

  function collectPopis() {
    const out = [];
    document.querySelectorAll('#inv-body tbody tr').forEach((row) => {
      const v = row.querySelector('.popis-qty').value;
      if (v === '') return;
      const unit = row.dataset.unit;
      const book = Number(row.dataset.book);
      const countedBase = toBase(parseFloat(v) || 0, unit);
      const g = ingredients.find((x) => x.id === row.dataset.id);
      out.push({
        id: row.dataset.id, name: g ? g.name : '', unit,
        book, counted: countedBase, diff: countedBase - book,
        pp: Number(row.dataset.pp), sp: Number(row.dataset.sp),
      });
    });
    return out;
  }

  async function popisSync() {
    const rows = collectPopis().filter((r) => Math.abs(r.diff) > 1e-9);
    if (!rows.length) { toast('Ni razlik za uskladitev.', 'error'); return; }
    if (!confirm(`Uskladim zalogo za ${rows.length} postavk? Zaloga se nastavi na popisano stanje.`)) return;
    const btn = document.getElementById('popis-sync');
    btn.disabled = true; btn.textContent = 'Usklajujem…';
    try {
      for (const r of rows) {
        const { error } = await sb.rpc('receive_ingredient', { p_ingredient_id: r.id, p_delta: r.diff, p_reason: 'adjust', p_note: 'popis' });
        if (error) throw error;
      }
      toast('Zaloge usklajene.', 'success');
      await load();
    } catch (err) {
      console.error(err); toast('Napaka pri usklajevanju: ' + (err.message || ''), 'error', 6000);
    } finally {
      btn.disabled = false; btn.textContent = 'Uskladi zaloge';
    }
  }

  function popisPdf() {
    const rows = collectPopis();
    if (!rows.length) { toast('Vnesite popisano stanje.', 'error'); return; }
    let nabManko = 0, nabVisek = 0, prodManko = 0, prodVisek = 0;
    const trs = rows.map((r) => {
      const nab = r.diff * r.pp;
      const prod = r.diff * r.sp;
      if (r.diff < 0) { nabManko += nab; prodManko += prod; } else { nabVisek += nab; prodVisek += prod; }
      const pu = purchaseUnit(r.unit);
      const cls = r.diff < 0 ? 'manko' : r.diff > 0 ? 'visek' : '';
      return `<tr class="${cls}">
        <td>${esc(r.name)}</td>
        <td class="r">${num(toPurchase(r.book, r.unit))} ${pu}</td>
        <td class="r">${num(toPurchase(r.counted, r.unit))} ${pu}</td>
        <td class="r">${r.diff > 0 ? '+' : ''}${num(toPurchase(r.diff, r.unit))} ${pu}</td>
        <td class="r">${formatPrice(r.pp * factor(r.unit), cur())}</td>
        <td class="r">${formatPrice(nab, cur())}</td>
        <td class="r">${formatPrice(prod, cur())}</td>
      </tr>`;
    }).join('');
    const now = new Date().toLocaleString('sl-SI', { timeZone: 'Europe/Ljubljana' });
    const html = `<!DOCTYPE html><html lang="sl"><head><meta charset="utf-8"><title>Popis blaga</title>
      <style>
        body{font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#000;padding:24px}
        h1{margin:0 0 4px} .sub{color:#555;margin-bottom:16px}
        table{width:100%;border-collapse:collapse;font-size:12px}
        th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
        .r{text-align:right}
        tr.manko td{background:#fde8e8} tr.visek td{background:#e8f7ee}
        tfoot td{font-weight:700}
        .totals{margin-top:16px;width:auto}
      </style></head><body onload="window.print()">
      <h1>Popis blaga</h1>
      <div class="sub">${esc(tenant.business_name || tenant.name)} — ${now}</div>
      <table>
        <thead><tr><th>Naziv</th><th class="r">Knjižno</th><th class="r">Popisano</th><th class="r">Razlika</th><th class="r">Nab. cena</th><th class="r">Nab. vrednost</th><th class="r">Prod. vrednost</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
      <table class="totals">
        <tr><td>Manko (nabavna)</td><td class="r">${formatPrice(nabManko, cur())}</td></tr>
        <tr><td>Višek (nabavna)</td><td class="r">${formatPrice(nabVisek, cur())}</td></tr>
        <tr><td>Neto (nabavna)</td><td class="r">${formatPrice(nabManko + nabVisek, cur())}</td></tr>
        <tr><td>Manko (prodajna)</td><td class="r">${formatPrice(prodManko, cur())}</td></tr>
        <tr><td>Višek (prodajna)</td><td class="r">${formatPrice(prodVisek, cur())}</td></tr>
      </table>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast('Brskalnik je blokiral okno za tisk.', 'error'); return; }
    w.document.write(html); w.document.close();
  }

  // --- Modal: dodaj/uredi -----------------------------------------------------
  function syncUnitLabels() {
    const pu = purchaseUnit(document.getElementById('ing-unit').value);
    document.querySelectorAll('.ing-punit').forEach((el) => { el.textContent = pu; });
  }

  function openModal(id) {
    editingId = id || null;
    const g = id ? ingredients.find((x) => x.id === id) : null;
    document.getElementById('ing-modal-title').textContent = g ? 'Uredi surovino' : 'Nova surovina / blago';
    document.getElementById('ing-name').value = g?.name || '';
    document.getElementById('ing-unit').value = g?.unit || 'ml';
    syncUnitLabels();
    const f = factor(g?.unit || 'ml');
    document.getElementById('ing-purchase').value = g ? (Number(g.purchase_price || 0) * f) : 0;
    document.getElementById('ing-sale').value = g ? (Number(g.sale_price || 0) * f) : 0;
    document.getElementById('ing-stock-field').style.display = g ? 'none' : '';
    document.getElementById('ing-stock').value = 0;
    document.getElementById('ing-cost-ratio').value = 30;
    recalcSuggestedSale();
    document.getElementById('ing-modal').classList.add('open');
  }

  // Predlagana prodajna cena po standardni gostinski formuli "delež stroška":
  // cena = nabavna cena / delež stroška. 30 % je splošno pravilo; pijače, kjer
  // je marža po navadi višja, gredo pogosto na 15-20 %. Samo predlog — polje
  // prodajne cene ostane ročno urejljivo, "Uporabi" ga samo prekopira.
  function recalcSuggestedSale() {
    const purchase = Number(document.getElementById('ing-purchase').value) || 0;
    const ratio = Math.min(95, Math.max(1, Number(document.getElementById('ing-cost-ratio').value) || 30));
    const suggested = purchase > 0 ? purchase / (ratio / 100) : 0;
    document.getElementById('ing-suggested-sale').value = suggested > 0 ? suggested.toFixed(4) : '';
  }

  async function saveIngredient() {
    const name = document.getElementById('ing-name').value.trim();
    const unit = document.getElementById('ing-unit').value;
    if (!name) return toast('Vnesite naziv.', 'error');
    const f = factor(unit);
    const payload = {
      tenant_id: tenant.id, name, unit,
      purchase_price: (Number(document.getElementById('ing-purchase').value) || 0) / f,
      sale_price: (Number(document.getElementById('ing-sale').value) || 0) / f,
    };
    if (!editingId) payload.stock_quantity = toBase(Number(document.getElementById('ing-stock').value) || 0, unit);
    const q = editingId
      ? sb.from('ingredients').update(payload).eq('id', editingId)
      : sb.from('ingredients').insert(payload);
    const { error } = await q;
    if (error) { console.error(error); return toast('Napaka: ' + (error.message || ''), 'error', 6000); }
    document.getElementById('ing-modal').classList.remove('open');
    toast('Shranjeno.', 'success');
    await load();
  }

  async function del(id) {
    if (!confirm('Izbrišem? Odstrani se tudi iz vseh receptur.')) return;
    const { error } = await sb.from('ingredients').delete().eq('id', id);
    if (error) return toast('Napaka pri brisanju.', 'error');
    toast('Izbrisano.', 'success'); await load();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
