// ============================================================================
// EPO.SI — Računi (invoices): izdaja + prikaz + tiskanje
// Slovenska zakonodaja (ZDDV-1 obvezni elementi, ZDavPR struktura).
// TESTNI način: računi NISO davčno potrjeni (brez FURS ZOI/EOR) in so kot taki
// jasno označeni. Realno FURS potrjevanje se doda kasneje (tenant.fiscal_enabled).
// ============================================================================

const Invoice = (() => {
  let modalReady = false;

  function ensureModal() {
    if (modalReady) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal-backdrop" id="invoice-modal">
        <div class="modal glass" style="max-width:520px">
          <div class="modal-head">
            <h2>🧾 Račun</h2>
            <button class="btn btn-ghost btn-icon" id="inv-close">✕</button>
          </div>
          <div id="inv-body"></div>
        </div>
      </div>`;
    document.body.appendChild(wrap.firstElementChild);
    document.getElementById('inv-close').addEventListener('click', close);
    document.getElementById('invoice-modal').addEventListener('click', (e) => {
      if (e.target.id === 'invoice-modal') close();
    });
    modalReady = true;
  }

  function open(order, tableLabel) {
    ensureModal();
    document.getElementById('invoice-modal').classList.add('open');
    loadOrIssue(order, tableLabel);
  }

  // Račun na ravni MIZE: skupni (vse postavke) ali deljeni (izbrane postavke).
  function openForTable(tableId, tableLabel) {
    ensureModal();
    document.getElementById('invoice-modal').classList.add('open');
    loadTableBilling(tableId, tableLabel);
  }
  function close() {
    const m = document.getElementById('invoice-modal');
    if (m) m.classList.remove('open');
  }

  async function loadOrIssue(order, tableLabel) {
    const body = document.getElementById('inv-body');
    body.innerHTML = '<div class="spinner"></div>';
    // Že izdan račun za to naročilo?
    const { data: existing } = await sb.from('invoices').select('*')
      .eq('order_id', order.id).order('created_at').limit(1).maybeSingle();
    if (existing) { showReceipt(existing, tableLabel); return; }
    showIssueForm(order, tableLabel);
  }

  function showIssueForm(order, tableLabel) {
    const body = document.getElementById('inv-body');
    body.innerHTML = `
      <p class="muted">Izdaja računa za naročilo z mize <strong>${esc(tableLabel || '')}</strong>.</p>
      <div class="field">
        <label>Način plačila</label>
        <select class="select" id="inv-pay">
          <option value="gotovina">Gotovina</option>
          <option value="kartica">Kartica</option>
          <option value="drugo">Drugo</option>
        </select>
      </div>
      <button class="btn btn-primary btn-block" id="inv-issue">Izdaj račun</button>`;
    document.getElementById('inv-issue').addEventListener('click', async () => {
      const btn = document.getElementById('inv-issue');
      btn.disabled = true; btn.textContent = 'Izdajam…';
      const { data, error } = await sb.rpc('issue_invoice', {
        p_order_id: order.id,
        p_payment_method: document.getElementById('inv-pay').value,
      });
      if (error) {
        console.error(error);
        toast('Napaka pri izdaji računa: ' + (error.message || ''), 'error', 6000);
        btn.disabled = false; btn.textContent = 'Izdaj račun';
        return;
      }
      // rpc returns the row (array or object depending on PostgREST)
      const inv = Array.isArray(data) ? data[0] : data;
      window.dispatchEvent(new CustomEvent('epo:invoiced'));
      showReceipt(inv, tableLabel);
    });
  }

  // --- Obračun mize: izbira postavk (skupni / deljeni) ----------------------
  async function loadTableBilling(tableId, tableLabel) {
    const body = document.getElementById('inv-body');
    body.innerHTML = '<div class="spinner"></div>';

    // Neobračunane postavke vseh aktivnih (nepreklicanih) naročil te mize.
    const { data: rawItems, error } = await sb.from('order_items')
      .select('id, item_name, item_price, quantity, order_id, orders!inner(table_id, status, created_at)')
      .is('invoice_id', null)
      .eq('orders.table_id', tableId)
      .neq('orders.status', 'cancelled');
    if (error) {
      console.error(error);
      body.innerHTML = `<p class="muted">Napaka pri nalaganju.</p>
        <p class="rcpt-test" style="margin-top:10px">${esc(error.message || String(error))}</p>
        <p class="muted" style="font-size:.8rem">Če napaka omenja <code>invoice_id</code> ali <code>issue_invoice_for_items</code>, zaženite migracijo <code>supabase/migrations/005_invoice_items.sql</code>.</p>`;
      return;
    }

    // Že izdani računi te mize (za ponovni tisk).
    const { data: invs } = await sb.from('invoices').select('*')
      .eq('table_id', tableId).order('created_at', { ascending: false });

    const items = rawItems || [];
    renderTableBilling(tableId, tableLabel, items, invs || []);
  }

  function renderTableBilling(tableId, tableLabel, items, invs) {
    const body = document.getElementById('inv-body');
    const cur = (window.AdminShell && AdminShell.tenant && AdminShell.tenant.currency) || '€';

    const lines = items.map((it) => `
      <div class="bill-line" data-id="${it.id}" data-price="${it.item_price}" data-max="${it.quantity}">
        <input type="checkbox" class="bill-cb" checked />
        <span class="bill-name">${esc(it.item_name)} <span class="muted" style="font-weight:400">${formatPrice(it.item_price, cur)}/kos</span></span>
        <div class="bill-qtybox">
          <button class="btn btn-sm bill-minus" type="button">−</button>
          <input class="input bill-qty-in" type="number" min="0" max="${it.quantity}" value="${it.quantity}" />
          <button class="btn btn-sm bill-plus" type="button">＋</button>
          <span class="muted">/ ${it.quantity}</span>
        </div>
        <span class="bill-amt">${formatPrice(it.item_price * it.quantity, cur)}</span>
      </div>`).join('');

    const invList = invs.length ? `
      <div class="bill-section">
        <h3>Izdani računi mize</h3>
        ${invs.map((v) => `
          <div class="row" style="padding:6px 0;border-bottom:1px solid var(--glass-border)">
            <span><strong>${esc(v.invoice_number)}</strong> · ${formatPrice(v.gross_total, cur)}
              <span class="muted">(${esc(payLabel(v.payment_method))})</span></span>
            <button class="btn btn-sm" data-reprint="${v.id}" style="margin-left:auto">🖨 Ponovni tisk</button>
          </div>`).join('')}
      </div>` : '';

    body.innerHTML = `
      <p class="muted">Miza <strong>${esc(tableLabel || '')}</strong> — izberite postavke in količine
        (vse = skupni račun, del = deljeni račun, npr. 1 od 2 kav).</p>
      ${items.length ? `
        <div class="row" style="margin-bottom:8px">
          <button class="btn btn-sm" id="bill-all">Izberi vse</button>
          <button class="btn btn-sm" id="bill-none">Počisti</button>
          <span class="spacer"></span>
          <strong id="bill-sum"></strong>
        </div>
        <div class="bill-list">${lines}</div>
        <div class="field" style="margin-top:12px">
          <label>Način plačila</label>
          <select class="select" id="inv-pay">
            <option value="gotovina">Gotovina</option>
            <option value="kartica">Kartica</option>
            <option value="drugo">Drugo</option>
          </select>
        </div>
        <div class="muted" style="font-size:.8rem;margin:4px 0 12px">Plačane postavke se obračunajo; ko je plačano vse, se miza zapre (gre v »postreženo«).</div>
        <button class="btn btn-primary btn-block" id="bill-issue">Obračunaj izbrano</button>
      ` : '<div class="empty-state"><div class="emoji">✅</div><p>Ni neobračunanih postavk za to mizo.</p></div>'}
      ${invList}`;

    if (items.length) {
      const rows = () => Array.from(body.querySelectorAll('.bill-line'));
      const lineQty = (row) => {
        const cb = row.querySelector('.bill-cb');
        if (!cb.checked) return 0;
        const max = Number(row.dataset.max);
        let q = parseInt(row.querySelector('.bill-qty-in').value, 10);
        if (isNaN(q) || q < 0) q = 0;
        return Math.min(q, max);
      };
      const recalc = () => {
        let sum = 0;
        rows().forEach((row) => {
          const q = lineQty(row);
          const amt = q * Number(row.dataset.price);
          row.querySelector('.bill-amt').textContent = formatPrice(amt, cur);
          row.style.opacity = row.querySelector('.bill-cb').checked ? '1' : '0.5';
          sum += amt;
        });
        document.getElementById('bill-sum').textContent = formatPrice(sum, cur);
      };
      rows().forEach((row) => {
        const input = row.querySelector('.bill-qty-in');
        const cb = row.querySelector('.bill-cb');
        const max = Number(row.dataset.max);
        cb.addEventListener('change', recalc);
        input.addEventListener('input', () => { cb.checked = Number(input.value) > 0; recalc(); });
        row.querySelector('.bill-minus').addEventListener('click', () => {
          input.value = Math.max(0, (parseInt(input.value, 10) || 0) - 1); cb.checked = Number(input.value) > 0; recalc();
        });
        row.querySelector('.bill-plus').addEventListener('click', () => {
          input.value = Math.min(max, (parseInt(input.value, 10) || 0) + 1); cb.checked = true; recalc();
        });
      });
      document.getElementById('bill-all').addEventListener('click', () => {
        rows().forEach((row) => { row.querySelector('.bill-cb').checked = true; row.querySelector('.bill-qty-in').value = row.dataset.max; });
        recalc();
      });
      document.getElementById('bill-none').addEventListener('click', () => {
        rows().forEach((row) => { row.querySelector('.bill-cb').checked = false; });
        recalc();
      });
      document.getElementById('bill-issue').addEventListener('click', () => issueSelected(tableId, tableLabel));
      recalc();
    }
    body.querySelectorAll('[data-reprint]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = invs.find((x) => x.id === b.dataset.reprint);
        if (v) showReceipt(v, tableLabel);
      }));
  }

  async function issueSelected(tableId, tableLabel) {
    const lines = [];
    document.querySelectorAll('.bill-line').forEach((row) => {
      const cb = row.querySelector('.bill-cb');
      if (!cb.checked) return;
      let q = parseInt(row.querySelector('.bill-qty-in').value, 10);
      q = Math.min(isNaN(q) ? 0 : q, Number(row.dataset.max));
      if (q > 0) lines.push({ id: row.dataset.id, qty: q });
    });
    if (!lines.length) { toast('Izberite vsaj eno postavko.', 'error'); return; }
    const btn = document.getElementById('bill-issue');
    btn.disabled = true; btn.textContent = 'Obračunavam…';
    const { data, error } = await sb.rpc('issue_invoice_for_quantities', {
      p_lines: lines,
      p_payment_method: document.getElementById('inv-pay').value,
    });
    if (error) {
      console.error(error);
      toast('Napaka pri obračunu: ' + (error.message || ''), 'error', 6000);
      btn.disabled = false; btn.textContent = 'Obračunaj izbrano';
      return;
    }
    const inv = Array.isArray(data) ? data[0] : data;

    // Po obračunu: naročila te mize, ki so v CELOTI plačana, gredo v "postreženo"
    // (miza/runda se zaključi). Delno plačane ostanejo odprte.
    const { data: tOrders } = await sb.from('orders')
      .select('id, status, order_items(invoice_id)')
      .eq('table_id', tableId).neq('status', 'cancelled');
    const fullyPaid = (tOrders || []).filter((o) =>
      o.status !== 'served' && (o.order_items || []).length > 0 && o.order_items.every((i) => i.invoice_id));
    if (fullyPaid.length) {
      await sb.from('orders').update({ status: 'served' }).in('id', fullyPaid.map((o) => o.id));
    }
    const stillOpen = (tOrders || []).some((o) => (o.order_items || []).some((i) => !i.invoice_id));
    toast(stillOpen ? 'Račun izdan. Miza ostaja odprta.' : 'Račun izdan. Miza zaprta.', 'success');
    window.dispatchEvent(new CustomEvent('epo:invoiced'));
    showReceipt(inv, tableLabel);
  }

  async function showReceipt(inv, tableLabel) {
    const body = document.getElementById('inv-body');
    // FURS potrjevanje samo če je vklopljeno (v testu je fiscal_enabled=false → preskok).
    const tenant = (window.AdminShell && AdminShell.tenant) || {};
    if (tenant.fiscal_enabled && !inv.eor) {
      body.innerHTML = '<div class="spinner"></div><p class="muted text-center">Davčno potrjevanje (FURS)…</p>';
      inv = await fiscalize(inv);
    }
    let qrImg = '';
    if (inv.zoi && inv.eor) {
      // Po možnosti uporabi QR, ki ga je vrnil strežnik (zagotovljena skladnost).
      const qrText = inv.qr || fursQrData(inv.zoi, String(inv.seller_tax_number || '').replace(/^SI/i, ''), inv.issued_at);
      qrImg = await qrDataUrl(qrText);
    }
    body.innerHTML = `
      <div id="receipt-print-area">${receiptHTML(inv, tableLabel, qrImg)}</div>
      <div class="modal-actions no-print">
        <button class="btn" id="inv-close2">Zapri</button>
        <button class="btn btn-primary" id="inv-print">🖨 Natisni</button>
      </div>`;
    document.getElementById('inv-close2').addEventListener('click', close);
    document.getElementById('inv-print').addEventListener('click', () => printReceipt(inv, tableLabel, qrImg));
  }

  // Pokliče Edge funkcijo za davčno potrjevanje (samo če je FURS vklopljen).
  async function fiscalize(inv) {
    try {
      const { data, error } = await sb.functions.invoke('furs-fiscalize', { body: { invoice_id: inv.id } });
      if (error) throw error;
      if (data && data.eor) return { ...inv, zoi: data.zoi, eor: data.eor, qr: data.qr, is_fiscal: true };
      throw new Error((data && data.message) || 'Brez EOR');
    } catch (e) {
      console.error(e);
      toast('Davčno potrjevanje ni uspelo — račun ostaja nepotrjen.', 'error', 5000);
      return inv;
    }
  }

  // QR vsebina po FURS (60 števk) — zrcali supabase/functions/_shared/furs.ts.
  // Datum/čas v coni Europe/Ljubljana (enako kot strežnik).
  function fursQrData(zoiHex, taxNumber, iso) {
    const dec = BigInt('0x' + zoiHex).toString().padStart(39, '0');
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Ljubljana', year: '2-digit', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(iso));
    const m = {}; parts.forEach((x) => { m[x.type] = x.value; });
    const dt = m.year + m.month + m.day + m.hour + m.minute + m.second;
    const base = dec + String(taxNumber).padStart(8, '0') + dt;
    const ctrl = (base.split('').reduce((a, c) => a + Number(c), 0) % 10).toString();
    return base + ctrl;
  }

  function qrDataUrl(text) {
    return new Promise((resolve) => {
      if (!window.QRCode) return resolve('');
      const tmp = document.createElement('div');
      tmp.style.display = 'none';
      document.body.appendChild(tmp);
      new QRCode(tmp, { text, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M });
      setTimeout(() => {
        const c = tmp.querySelector('canvas');
        const img = tmp.querySelector('img');
        const url = c ? c.toDataURL('image/png') : (img ? img.src : '');
        tmp.remove();
        resolve(url);
      }, 60);
    });
  }

  // --- Receipt markup (vsi obvezni elementi po ZDDV-1) ----------------------
  function receiptHTML(inv, tableLabel, qrImg) {
    const cur = inv.currency || '€';
    const items = (inv.items || []).map((it) => `
      <tr>
        <td>${esc(it.name)}</td>
        <td class="r">${it.qty}</td>
        <td class="r">${formatPrice(it.unit_price, cur)}</td>
        ${inv.seller_vat_registered ? `<td class="r">${Number(it.vat_rate).toFixed(1)}%</td>` : ''}
        <td class="r">${formatPrice(it.line_total, cur)}</td>
      </tr>`).join('');

    const vatRows = (inv.vat_breakdown || []).map((v) => `
      <tr>
        <td>${Number(v.rate).toFixed(1)}%</td>
        <td class="r">${formatPrice(v.base, cur)}</td>
        <td class="r">${formatPrice(v.vat, cur)}</td>
      </tr>`).join('');

    const sellerVat = inv.seller_vat_registered
      ? `<div>ID za DDV: SI${esc((inv.seller_tax_number || '').replace(/^SI/i, ''))}</div>`
      : `<div>Davčna številka: ${esc(inv.seller_tax_number || '—')}</div>
         <div class="rcpt-note-small">DDV ni obračunan na podlagi 1. odst. 94. člena ZDDV-1 (nisem zavezanec za DDV).</div>`;

    const cols = inv.seller_vat_registered ? 5 : 4;

    const fiscalBlock = (inv.is_fiscal && inv.eor)
      ? `${qrImg ? `<div class="rcpt-qr"><img src="${qrImg}" alt="FURS QR" width="140" height="140"></div>` : ''}
         <div class="rcpt-row"><span>ZOI:</span><span>${esc(inv.zoi || '—')}</span></div>
         <div class="rcpt-row"><span>EOR:</span><span>${esc(inv.eor || '—')}</span></div>`
      : `<div class="rcpt-test">⚠️ TESTNI RAČUN — NI DAVČNO POTRJEN (ZDavPR).<br>
           Ne uporabljati v pravnem prometu. Davčno potrjevanje (FURS: ZOI / EOR / QR) se aktivira pred uporabo v živo.</div>`;

    return `
      <div class="receipt">
        <div class="rcpt-head">
          <div class="rcpt-seller-name">${esc(inv.seller_name || '')}</div>
          ${inv.seller_address ? `<div>${esc(inv.seller_address)}</div>` : ''}
          ${sellerVat}
        </div>

        <div class="rcpt-title">RAČUN</div>
        <div class="rcpt-row"><span>Št. računa:</span><span><strong>${esc(inv.invoice_number)}</strong></span></div>
        <div class="rcpt-row"><span>Datum in čas:</span><span>${formatDateTime(inv.issued_at)}</span></div>
        ${tableLabel ? `<div class="rcpt-row"><span>Miza:</span><span>${esc(tableLabel)}</span></div>` : ''}
        ${inv.operator_name ? `<div class="rcpt-row"><span>Operater:</span><span>${esc(inv.operator_name)}</span></div>` : ''}

        <table class="rcpt-table">
          <thead><tr>
            <th>Naziv</th><th class="r">Kol.</th><th class="r">Cena</th>
            ${inv.seller_vat_registered ? '<th class="r">DDV</th>' : ''}<th class="r">Skupaj</th>
          </tr></thead>
          <tbody>${items}</tbody>
        </table>

        ${inv.seller_vat_registered ? `
        <table class="rcpt-table rcpt-vat">
          <thead><tr><th>Stopnja</th><th class="r">Osnova</th><th class="r">DDV</th></tr></thead>
          <tbody>${vatRows}</tbody>
          <tfoot><tr><td>Skupaj</td><td class="r">${formatPrice(inv.net_total, cur)}</td><td class="r">${formatPrice(inv.vat_total, cur)}</td></tr></tfoot>
        </table>` : ''}

        <div class="rcpt-total">
          <span>ZA PLAČILO</span>
          <span>${formatPrice(inv.gross_total, cur)}</span>
        </div>
        <div class="rcpt-row"><span>Način plačila:</span><span>${esc(payLabel(inv.payment_method))}</span></div>

        <div class="rcpt-fiscal">${fiscalBlock}</div>

        <div class="rcpt-foot">Hvala in nasvidenje! 🙂</div>
      </div>`;
  }

  function payLabel(m) {
    return ({ gotovina: 'Gotovina', kartica: 'Kartica', drugo: 'Drugo' })[m] || (m || '—');
  }

  // --- Print v ločenem oknu (čist izpis, primeren za 80mm/A4) ----------------
  function printReceipt(inv, tableLabel, qrImg) {
    const w = window.open('', '_blank', 'width=400,height=640');
    if (!w) { toast('Brskalnik je blokiral pojavno okno za tisk.', 'error'); return; }
    w.document.write(`<!DOCTYPE html><html lang="sl"><head><meta charset="utf-8">
      <title>Račun ${esc(inv.invoice_number)}</title>
      <style>${PRINT_CSS}</style></head>
      <body onload="window.print()">${receiptHTML(inv, tableLabel, qrImg)}</body></html>`);
    w.document.close();
  }

  const PRINT_CSS = `
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color:#000; background:#fff; margin:0; padding:12px; }
    .receipt { width: 320px; margin: 0 auto; font-size: 13px; }
    .rcpt-head { text-align:center; margin-bottom:10px; }
    .rcpt-seller-name { font-weight:800; font-size:15px; }
    .rcpt-note-small { font-size:11px; color:#333; margin-top:4px; }
    .rcpt-title { text-align:center; font-weight:800; font-size:18px; letter-spacing:2px; margin:10px 0; border-top:1px dashed #000; border-bottom:1px dashed #000; padding:6px 0; }
    .rcpt-row { display:flex; justify-content:space-between; gap:8px; margin:2px 0; }
    .rcpt-table { width:100%; border-collapse:collapse; margin:10px 0; }
    .rcpt-table th, .rcpt-table td { text-align:left; padding:3px 2px; border-bottom:1px solid #ddd; font-size:12px; }
    .rcpt-table .r { text-align:right; }
    .rcpt-table tfoot td { font-weight:700; border-top:1px solid #000; border-bottom:none; }
    .rcpt-vat th, .rcpt-vat td { font-size:11px; }
    .rcpt-total { display:flex; justify-content:space-between; font-weight:800; font-size:17px; margin:10px 0; border-top:2px solid #000; border-bottom:2px solid #000; padding:8px 0; }
    .rcpt-fiscal { margin:10px 0; }
    .rcpt-test { border:2px dashed #c00; color:#c00; padding:8px; font-size:11px; font-weight:700; text-align:center; border-radius:6px; }
    .rcpt-qr { text-align:center; margin:8px 0; }
    .rcpt-qr img { width:140px; height:140px; }
    .rcpt-foot { text-align:center; margin-top:12px; font-size:12px; }
  `;

  return { open, openForTable, close };
})();

window.Invoice = Invoice;
