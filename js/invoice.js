// ============================================================================
// EPO.SI — Invoices: issuing + display + printing
// Slovenian legislation (ZDDV-1 mandatory elements, ZDavPR structure).
// TEST mode: invoices are NOT fiscally verified (no FURS ZOI/EOR) and are
// clearly marked as such. Real FURS fiscalization is enabled later via
// tenant.fiscal_enabled.
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

  // Table-level invoice: full (all items) or split (selected items).
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
    // Has an invoice already been issued for this order?
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

  // --- Table billing: item selection (full / split) --------------------------
  async function loadTableBilling(tableId, tableLabel) {
    const body = document.getElementById('inv-body');
    body.innerHTML = '<div class="spinner"></div>';

    // Unbilled items from all active (non-cancelled) orders for this table.
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

    // Invoices already issued for this table (for reprinting).
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
            <span><strong>${esc(v.invoice_number)}</strong>${v.doc_type === 'storno' ? ' <span class="badge badge-cancelled">STORNO</span>' : ''} · ${formatPrice(v.gross_total, cur)}
              <span class="muted">(${esc(payLabel(v.payment_method))})</span>${v.voided_by_invoice_id ? ' <span class="muted">— storniran</span>' : ''}</span>
            <button class="btn btn-sm" data-reprint="${v.id}" style="margin-left:auto">🖨</button>
            ${(v.doc_type !== 'storno' && !v.voided_by_invoice_id) ? `<button class="btn btn-sm btn-danger" data-storno="${v.id}">Storno</button>` : ''}
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
        <div class="row wrap" style="margin-top:12px">
          <div class="field" style="width:120px;margin:0"><label>Popust (%)</label><input class="input" type="number" min="0" max="100" step="1" id="bill-disc" value="0" /></div>
          <div class="field" style="width:120px;margin:0"><label>Napitnina</label><input class="input" type="number" min="0" step="0.01" id="bill-tip" value="0" /></div>
          <div class="field" style="flex:1;min-width:140px;margin:0"><label>Način plačila</label>
            <select class="select" id="inv-pay">
              <option value="gotovina">Gotovina</option>
              <option value="kartica">Kartica</option>
              <option value="drugo">Drugo</option>
              <option value="mesano">Deljeno (gotovina + kartica)</option>
            </select>
          </div>
        </div>
        <div id="bill-split" class="row wrap hidden" style="margin-top:8px">
          <div class="field" style="flex:1;margin:0"><label>Gotovina</label><input class="input" type="number" min="0" step="0.01" id="bill-cash" value="0" /></div>
          <div class="field" style="flex:1;margin:0"><label>Kartica</label><input class="input" type="number" min="0" step="0.01" id="bill-card" value="0" /></div>
          <div class="field" style="flex:1;margin:0"><label>Drugo</label><input class="input" type="number" min="0" step="0.01" id="bill-other" value="0" /></div>
        </div>
        <div class="muted" style="font-size:.8rem;margin:8px 0 12px">Za plačilo: <strong id="bill-grand"></strong>. Ko je plačano vse, se miza zapre.</div>
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
      let grandTotal = 0;
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
        const disc = Math.min(100, Math.max(0, Number(document.getElementById('bill-disc').value) || 0));
        grandTotal = Math.round(sum * (1 - disc / 100) * 100) / 100;
        document.getElementById('bill-grand').textContent = formatPrice(grandTotal, cur);
      };

      // Split payment: entering one amount auto-computes the remainder.
      const fld = (id) => document.getElementById(id);
      const val = (id) => Math.max(0, Number(fld(id).value) || 0);
      const setVal = (id, n) => { fld(id).value = (Math.round(Math.max(0, n) * 100) / 100).toFixed(2); };
      const autoSplit = (changed) => {
        const cash = val('bill-cash'), card = val('bill-card'), other = val('bill-other');
        if (changed === 'cash') setVal('bill-card', grandTotal - cash - other);
        else if (changed === 'card') setVal('bill-cash', grandTotal - card - other);
        else setVal('bill-cash', grandTotal - other - card);
      };
      ['cash', 'card', 'other'].forEach((k) =>
        fld('bill-' + k).addEventListener('input', () => autoSplit(k)));
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
      document.getElementById('bill-disc').addEventListener('input', recalc);
      document.getElementById('inv-pay').addEventListener('change', (e) => {
        const split = e.target.value === 'mesano';
        document.getElementById('bill-split').classList.toggle('hidden', !split);
        if (split) { recalc(); setVal('bill-cash', grandTotal); setVal('bill-card', 0); setVal('bill-other', 0); }
      });
      document.getElementById('bill-issue').addEventListener('click', () => issueSelected(tableId, tableLabel));
      recalc();
    }
    body.querySelectorAll('[data-reprint]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = invs.find((x) => x.id === b.dataset.reprint);
        if (v) showReceipt(v, tableLabel);
      }));
    body.querySelectorAll('[data-storno]').forEach((b) =>
      b.addEventListener('click', () => storno(b.dataset.storno, tableId, tableLabel)));
  }

  async function storno(invoiceId, tableId, tableLabel) {
    if (!confirm('Storniram ta račun? Izda se dobropis (negativen račun), postavke se znova odprejo.')) return;
    const { data, error } = await sb.rpc('storno_invoice', { p_invoice_id: invoiceId });
    if (error) { console.error(error); toast('Napaka pri storno: ' + (error.message || ''), 'error', 6000); return; }
    const inv = Array.isArray(data) ? data[0] : data;
    window.dispatchEvent(new CustomEvent('epo:invoiced'));
    toast('Račun storniran.', 'success');
    showReceipt(inv, tableLabel);
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
    const pay = document.getElementById('inv-pay').value;
    const disc = Math.min(100, Math.max(0, Number(document.getElementById('bill-disc').value) || 0));
    const tip = Math.max(0, Number(document.getElementById('bill-tip').value) || 0);
    const split = pay === 'mesano';
    const btn = document.getElementById('bill-issue');
    btn.disabled = true; btn.textContent = 'Obračunavam…';
    const { data, error } = await sb.rpc('issue_invoice_for_quantities', {
      p_lines: lines,
      p_payment_method: split ? 'gotovina' : pay,
      p_discount_pct: disc,
      p_tip: tip,
      p_cash: split ? (Number(document.getElementById('bill-cash').value) || 0) : null,
      p_card: split ? (Number(document.getElementById('bill-card').value) || 0) : null,
      p_other: split ? (Number(document.getElementById('bill-other').value) || 0) : null,
    });
    if (error) {
      console.error(error);
      toast('Napaka pri obračunu: ' + (error.message || ''), 'error', 6000);
      btn.disabled = false; btn.textContent = 'Obračunaj izbrano';
      return;
    }
    const inv = Array.isArray(data) ? data[0] : data;

    // After billing: orders for this table that are FULLY paid move to "served"
    // (the table/round is closed). Partially paid orders remain open.
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
    // FURS fiscalization only if enabled (in test mode fiscal_enabled=false → skipped).
    const tenant = (window.AdminShell && AdminShell.tenant) || {};
    if (tenant.fiscal_enabled && !inv.eor) {
      body.innerHTML = '<div class="spinner"></div><p class="muted text-center">Davčno potrjevanje (FURS)…</p>';
      inv = await fiscalize(inv);
    }
    let qrImg = '';
    if (inv.zoi && inv.eor) {
      // Prefer the QR content returned by the server (guarantees consistency).
      const qrText = inv.qr || fursQrData(inv.zoi, String(inv.seller_tax_number || '').replace(/^SI/i, ''), inv.issued_at);
      qrImg = await qrDataUrl(qrText);
    }
    body.innerHTML = `
      <div id="receipt-print-area">${receiptHTML(inv, tableLabel, qrImg)}</div>
      <div class="modal-actions no-print">
        <button class="btn" id="inv-close2">Zapri</button>
        ${(inv.id && inv.doc_type !== 'storno' && !inv.voided_by_invoice_id) ? '<button class="btn btn-danger" id="inv-storno">Storno</button>' : ''}
        <button class="btn btn-primary" id="inv-print">🖨 Natisni</button>
      </div>`;
    document.getElementById('inv-close2').addEventListener('click', close);
    document.getElementById('inv-print').addEventListener('click', () => printReceipt(inv, tableLabel, qrImg));
    const stornoBtn = document.getElementById('inv-storno');
    if (stornoBtn) stornoBtn.addEventListener('click', () => storno(inv.id, inv.table_id, tableLabel));
  }

  // Opens an existing invoice (e.g. from History) — display + print + void.
  async function openInvoice(invoiceId, tableLabel) {
    ensureModal();
    document.getElementById('invoice-modal').classList.add('open');
    const body = document.getElementById('inv-body');
    body.innerHTML = '<div class="spinner"></div>';
    const { data, error } = await sb.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
    if (error || !data) { body.innerHTML = '<p class="muted">Računa ni mogoče naložiti.</p>'; return; }
    showReceipt(data, tableLabel);
  }

  // Calls the Edge function for fiscal verification (only if FURS is enabled).
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

  // QR content per FURS spec (60 digits) — mirrors supabase/functions/_shared/furs.ts.
  // Date/time in the Europe/Ljubljana zone (same as the server).
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

  // --- Receipt markup (all mandatory elements per ZDDV-1) --------------------
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

        <div class="rcpt-title">${inv.doc_type === 'storno' ? 'STORNO' : 'RAČUN'}</div>
        ${inv.ref_invoice_number ? `<div class="rcpt-row"><span>Sklic na račun:</span><span>${esc(inv.ref_invoice_number)}</span></div>` : ''}
        <div class="rcpt-row"><span>Št. računa:</span><span><strong>${esc(inv.invoice_number)}</strong></span></div>
        <div class="rcpt-row"><span>Datum in čas:</span><span>${formatDateTime(inv.issued_at)}</span></div>
        ${tableLabel ? `<div class="rcpt-row"><span>Miza:</span><span>${esc(tableLabel)}</span></div>` : ''}
        ${(inv.operator_code || inv.operator_name) ? `<div class="rcpt-row"><span>Natakar:</span><span>${esc(inv.operator_code || inv.operator_name)}</span></div>` : ''}

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

        ${Number(inv.discount_amount) > 0 ? `<div class="rcpt-row"><span>Popust ${Number(inv.discount_pct).toFixed(0)}%</span><span>-${formatPrice(inv.discount_amount, cur)}</span></div>` : ''}
        <div class="rcpt-total">
          <span>ZA PLAČILO</span>
          <span>${formatPrice(inv.gross_total, cur)}</span>
        </div>
        ${[['Gotovina', inv.amount_cash], ['Kartica', inv.amount_card], ['Drugo', inv.amount_other]]
          .filter(([, v]) => Number(v) > 0)
          .map(([k, v]) => `<div class="rcpt-row"><span>${k}</span><span>${formatPrice(v, cur)}</span></div>`).join('')
          || `<div class="rcpt-row"><span>Način plačila</span><span>${esc(payLabel(inv.payment_method))}</span></div>`}
        ${Number(inv.tip_amount) > 0 ? `<div class="rcpt-row"><span>Napitnina</span><span>${formatPrice(inv.tip_amount, cur)}</span></div>` : ''}

        <div class="rcpt-fiscal">${fiscalBlock}</div>

        <div class="rcpt-foot">Hvala in nasvidenje! 🙂</div>
      </div>`;
  }

  function payLabel(m) {
    return ({ gotovina: 'Gotovina', kartica: 'Kartica', drugo: 'Drugo' })[m] || (m || '—');
  }

  // --- Print: narrow layout for small (Bluetooth) thermal printers (58/80 mm) --
  function printReceipt(inv, tableLabel, qrImg) {
    const t = (window.AdminShell && AdminShell.tenant) || {};
    const width = Number(t.receipt_width) === 80 ? 80 : 58;
    const logo = t.logo_url || '';
    const w = window.open('', '_blank', 'width=380,height=640');
    if (!w) { toast('Brskalnik je blokiral pojavno okno za tisk.', 'error'); return; }
    w.document.write(`<!DOCTYPE html><html lang="sl"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Račun ${esc(inv.invoice_number)}</title>
      <style>${printCss(width)}</style></head>
      <body onload="setTimeout(function(){window.print();},200)">${thermalReceiptHTML(inv, tableLabel, qrImg, logo)}</body></html>`);
    w.document.close();
  }

  // Narrow, single-color, monospace layout (reliable on thermal printers).
  function thermalReceiptHTML(inv, tableLabel, qrImg, logo) {
    const c = inv.currency || '€';
    const price = (n) => Number(n || 0).toFixed(2).replace('.', ',');

    const items = (inv.items || []).map((it) => `
      <div class="t-item">
        <div class="t-iname">${esc(it.name)}</div>
        <div class="t-row"><span>${it.qty} x ${price(it.unit_price)}${inv.seller_vat_registered ? ' (' + Number(it.vat_rate).toFixed(0) + '%)' : ''}</span><span>${price(it.line_total)} ${c}</span></div>
      </div>`).join('');

    const vat = inv.seller_vat_registered ? `
      <div class="hr"></div>
      <div class="t-row t-small"><span>Osnova</span><span>DDV</span></div>
      ${(inv.vat_breakdown || []).map((v) => `
        <div class="t-row t-small"><span>${Number(v.rate).toFixed(1)}%: ${price(v.base)}</span><span>${price(v.vat)} ${c}</span></div>`).join('')}` : `
      <div class="t-small" style="margin-top:4px">DDV ni obračunan (1. odst. 94. čl. ZDDV-1).</div>`;

    const fiscal = (inv.is_fiscal && inv.eor) ? `
      ${qrImg ? `<div class="t-qr"><img src="${qrImg}" alt="QR"></div>` : ''}
      <div class="t-small">ZOI: ${esc(inv.zoi || '')}</div>
      <div class="t-small">EOR: ${esc(inv.eor || '')}</div>` : `
      <div class="t-test">TESTNI RAČUN<br>NI DAVČNO POTRJEN (ZDavPR)</div>`;

    const pays = [];
    if (Number(inv.amount_cash) > 0) pays.push(['Gotovina', inv.amount_cash]);
    if (Number(inv.amount_card) > 0) pays.push(['Kartica', inv.amount_card]);
    if (Number(inv.amount_other) > 0) pays.push(['Drugo', inv.amount_other]);
    if (!pays.length) pays.push([payLabel(inv.payment_method), inv.gross_total]);
    const payRows = pays.map(([k, v]) => `<div class="t-row"><span>${k}:</span><span>${price(v)} ${c}</span></div>`).join('');
    const discRow = Number(inv.discount_amount) > 0
      ? `<div class="t-row"><span>Popust ${Number(inv.discount_pct).toFixed(0)}%:</span><span>-${price(inv.discount_amount)} ${c}</span></div>` : '';
    const tipRow = Number(inv.tip_amount) > 0
      ? `<div class="t-row"><span>Napitnina:</span><span>${price(inv.tip_amount)} ${c}</span></div>` : '';

    return `
      ${logo ? `<div class="t-qr"><img class="t-logo" src="${esc(logo)}" alt=""></div>` : ''}
      <div class="t-center t-name">${esc(inv.seller_name || '')}</div>
      ${inv.seller_address ? `<div class="t-center t-small">${esc(inv.seller_address)}</div>` : ''}
      <div class="t-center t-small">${inv.seller_vat_registered ? 'ID za DDV: SI' : 'Davčna št.: '}${esc((inv.seller_tax_number || '').replace(/^SI/i, ''))}</div>

      <div class="t-title">${inv.doc_type === 'storno' ? 'STORNO' : 'RAČUN'}</div>
      <div class="t-row"><span>Št.:</span><span>${esc(inv.invoice_number)}</span></div>
      ${inv.ref_invoice_number ? `<div class="t-row"><span>Sklic:</span><span>${esc(inv.ref_invoice_number)}</span></div>` : ''}
      <div class="t-row"><span>Datum:</span><span>${formatDateTime(inv.issued_at)}</span></div>
      ${tableLabel ? `<div class="t-row"><span>Miza:</span><span>${esc(tableLabel)}</span></div>` : ''}
      ${(inv.operator_code || inv.operator_name) ? `<div class="t-row"><span>Natakar:</span><span>${esc(inv.operator_code || inv.operator_name)}</span></div>` : ''}
      <div class="hr"></div>
      ${items}
      ${discRow}
      ${vat}
      <div class="t-total"><span>ZA PLAČILO</span><span>${price(inv.gross_total)} ${c}</span></div>
      ${payRows}
      ${tipRow}
      <div class="hr"></div>
      ${fiscal}
      <div class="t-center t-small" style="margin-top:6px">Hvala in nasvidenje!</div>`;
  }

  function printCss(width) {
    const w = width === 80 ? 80 : 58;
    const qr = w === 80 ? 40 : 30;
    return `
    @page { size: ${w}mm auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { width: ${w}mm; padding: 2mm 2.5mm; color: #000;
      font-family: 'Courier New', ui-monospace, monospace; font-size: ${w === 80 ? '10pt' : '9pt'}; line-height: 1.25; }
    .t-center { text-align: center; }
    .t-name { font-weight: 700; font-size: ${w === 80 ? '13pt' : '11pt'}; }
    .t-small { font-size: 8pt; }
    .t-logo { max-width: ${w - 14}mm; max-height: 18mm; filter: grayscale(1) contrast(1.4); margin: 0 auto 2px; }
    .t-title { text-align: center; font-weight: 700; font-size: ${w === 80 ? '14pt' : '12pt'}; letter-spacing: 2px; margin: 4px 0; }
    .hr { border-top: 1px dashed #000; margin: 4px 0; }
    .t-row { display: flex; justify-content: space-between; gap: 4px; }
    .t-item { margin: 3px 0; }
    .t-iname { font-weight: 700; }
    .t-total { display: flex; justify-content: space-between; font-weight: 700; font-size: ${w === 80 ? '14pt' : '12pt'};
      border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 3px 0; margin: 4px 0; }
    .t-test { border: 1px dashed #000; padding: 4px; font-size: 8pt; font-weight: 700; text-align: center; margin: 4px 0; }
    .t-qr { text-align: center; margin: 4px 0; }
    .t-qr img { width: ${qr}mm; height: ${qr}mm; }
    .t-qr img.t-logo { width: auto; height: auto; }
  `;
  }

  return { open, openForTable, openInvoice, close };
})();

window.Invoice = Invoice;

