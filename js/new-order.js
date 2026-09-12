// ============================================================================
// EPO.SI — Manual order (staff): table selection + adding items.
// Each submission creates an order (round) for the selected table, which
// appears on the dashboard in real time. Supports "sell anyway" when stock
// is insufficient.
// ============================================================================

(function () {
  let tenant = null;
  let tables = [];
  let categories = [];
  let items = [];
  let selectedTableId = null;
  const cart = {}; // id -> { id, name, price, qty, note, track_stock, stock_quantity }

  async function init() {
    const ctx = await AdminShell.init('neworder', 'Novo naročilo');
    if (!ctx) return;
    tenant = ctx.tenant;
    await load();
    renderLayout();
    buildCartUI();
    refresh();
  }

  async function load() {
    const [tb, c, i] = await Promise.all([
      sb.from('tables').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('table_number'),
      sb.from('categories').select('*').eq('tenant_id', tenant.id).eq('is_active', true).order('sort_order'),
      sb.from('menu_items').select('*').eq('tenant_id', tenant.id).order('sort_order'),
    ]);
    tables = tb.data || [];
    categories = c.data || [];
    items = i.data || [];
    // Keep the selected table (e.g. after submitting a round), else default to the first.
    if (!selectedTableId || !tables.some((t) => t.id === selectedTableId)) {
      selectedTableId = tables[0]?.id || null;
    }
  }

  function renderLayout() {
    document.getElementById('page-content').innerHTML = `
      <div class="field" style="max-width:360px">
        <label>Miza</label>
        <select class="select" id="no-table">
          ${tables.map((t) => `<option value="${t.id}" ${t.id === selectedTableId ? 'selected' : ''}>${esc(t.label || 'Miza ' + t.table_number)}</option>`).join('')}
        </select>
      </div>
      ${tables.length ? '' : '<p class="muted">Najprej dodajte mize v razdelku »Mize«.</p>'}
      <div id="no-tabs" class="cat-tabs"></div>
      <div id="no-list" class="menu-list" style="padding:8px 0 150px"></div>`;
    const sel = document.getElementById('no-table');
    if (sel) { sel.value = selectedTableId || ''; sel.addEventListener('change', (e) => { selectedTableId = e.target.value; }); }
    renderTabs();
    renderItems();
  }

  function renderTabs() {
    const host = document.getElementById('no-tabs');
    if (!categories.length) { host.innerHTML = ''; return; }
    host.innerHTML = categories.map((c, idx) => `
      <button class="cat-tab ${idx === 0 ? 'active' : ''}" data-cat="${c.id}">
        ${c.icon ? esc(c.icon) + ' ' : ''}<span>${esc(c.name)}</span>
      </button>`).join('');
    host.querySelectorAll('.cat-tab').forEach((t) => t.addEventListener('click', () => {
      host.querySelectorAll('.cat-tab').forEach((x) => x.classList.toggle('active', x === t));
      const h = document.getElementById(`no-cat-${t.dataset.cat}`);
      if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  function renderItems() {
    const host = document.getElementById('no-list');
    host.innerHTML = '';
    const groups = [...categories.map((c) => ({ cat: c, list: items.filter((i) => i.category_id === c.id) }))];
    const orphans = items.filter((i) => !categories.some((c) => c.id === i.category_id));
    if (orphans.length) groups.push({ cat: { id: 'none', name: 'Ostalo', icon: '' }, list: orphans });

    groups.forEach(({ cat, list }) => {
      if (!list.length) return;
      const h = document.createElement('h2');
      h.className = 'cat-heading';
      h.id = `no-cat-${cat.id}`;
      h.textContent = `${cat.icon || ''} ${cat.name}`.trim();
      host.appendChild(h);
      list.forEach((it) => host.appendChild(itemCard(it)));
    });
  }

  function stockBadge(it) {
    if (!it.track_stock) return '';
    if (it.stock_quantity <= 0) return '<span class="na-badge">Ni zaloge</span>';
    return `<span class="muted" style="font-size:.78rem">Zaloga: ${it.stock_quantity}</span>`;
  }

  function itemCard(it) {
    const card = document.createElement('div');
    card.className = 'menu-item glass' + (it.is_available ? '' : ' unavailable');
    card.dataset.id = it.id;
    const hasVariants = Array.isArray(it.variants) && it.variants.length > 0;
    const qty = cart[it.id]?.qty || 0;
    const controls = hasVariants
      ? `<div class="variant-row">${it.variants.map((v, i) => `<button class="variant-chip" data-vi="${i}">${esc(v.name)} · ${formatPrice(v.price, tenant.currency)}</button>`).join('')}</div>`
      : `<div class="stepper${qty > 0 ? ' has-qty' : ''}" data-id="${it.id}">
            <button class="step-btn add add-only" aria-label="Dodaj">＋</button>
            <div class="qty-controls">
              <button class="step-btn minus" aria-label="Odstrani">−</button>
              <span class="step-qty">${qty}</span>
              <button class="step-btn add plus" aria-label="Dodaj">＋</button>
            </div>
          </div>`;
    card.innerHTML = `
      <div class="item-main">
        <div class="item-name">${esc(it.name)}</div>
        <div class="item-bottom">
          <span class="item-price">${hasVariants ? 'od ' : ''}${formatPrice(hasVariants ? Math.min(...it.variants.map((v) => v.price)) : it.price, tenant.currency)}</span>
          ${stockBadge(it)}
          ${controls}
        </div>
      </div>`;
    if (hasVariants) {
      card.querySelectorAll('.variant-chip').forEach((chip) => chip.addEventListener('click', () => {
        const v = it.variants[Number(chip.dataset.vi)];
        addVariant(it, v);
      }));
    } else {
      const stepper = card.querySelector('.stepper');
      const add = () => addItem(it);
      card.querySelector('.add-only').addEventListener('click', add);
      card.querySelector('.plus').addEventListener('click', add);
      card.querySelector('.minus').addEventListener('click', () => removeItem(it.id));
      stepper._update = () => {
        const q = cart[it.id]?.qty || 0;
        stepper.classList.toggle('has-qty', q > 0);
        stepper.querySelector('.step-qty').textContent = q;
      };
    }
    return card;
  }

  function addVariant(it, v) {
    const key = `${it.id}|${v.name}`;
    if (cart[key]) cart[key].qty += 1;
    else cart[key] = { id: key, menu_item_id: it.id, name: `${it.name} – ${v.name}`, price: Number(v.price), qty: 1, note: '' };
    refresh();
  }

  function addItem(it) {
    const inCart = cart[it.id]?.qty || 0;
    // "Sell anyway" — if we track stock and it's insufficient, ask for confirmation.
    if (it.track_stock && inCart + 1 > it.stock_quantity) {
      const ok = confirm(`Ni dovolj zaloge za "${it.name}" (na voljo: ${Math.max(0, it.stock_quantity)}). Prodam vseeno?`);
      if (!ok) return;
    }
    if (cart[it.id]) cart[it.id].qty += 1;
    else cart[it.id] = { id: it.id, menu_item_id: it.id, name: it.name, price: Number(it.price), qty: 1, note: '' };
    refresh();
  }

  function removeItem(id) {
    if (!cart[id]) return;
    cart[id].qty -= 1;
    if (cart[id].qty <= 0) delete cart[id];
    refresh();
  }

  function state() {
    const list = Object.values(cart);
    return {
      list,
      count: list.reduce((s, i) => s + i.qty, 0),
      total: list.reduce((s, i) => s + i.qty * i.price, 0),
    };
  }

  // --- Cart bar + sheet -----------------------------------------------------
  function buildCartUI() {
    if (document.getElementById('no-cart-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'no-cart-bar';
    bar.className = 'cart-bar';
    bar.innerHTML = `
      <span class="cart-bar-count" id="no-count">0</span>
      <span class="cart-bar-label">Naročilo</span>
      <span class="cart-bar-total" id="no-total">0,00 €</span>`;
    document.body.appendChild(bar);

    const backdrop = document.createElement('div');
    backdrop.id = 'no-backdrop'; backdrop.className = 'sheet-backdrop';
    document.body.appendChild(backdrop);

    const sheet = document.createElement('section');
    sheet.id = 'no-sheet'; sheet.className = 'cart-sheet';
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header"><h2>🧾 Naročilo</h2>
        <button class="btn btn-ghost btn-icon sheet-close" id="no-sheet-close">✕</button></div>
      <div class="sheet-body" id="no-sheet-body"></div>
      <div class="sheet-footer">
        <div class="field"><label>Opomba</label>
          <textarea class="textarea" id="no-note" placeholder="npr. brez sladkorja"></textarea></div>
        <div class="summary-row summary-total"><span class="label">Skupaj</span>
          <span class="value" id="no-sheet-total">0,00 €</span></div>
        <button class="btn btn-primary btn-block" id="no-submit">Oddaj naročilo</button>
      </div>`;
    document.body.appendChild(sheet);

    bar.addEventListener('click', openSheet);
    document.getElementById('no-sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', closeSheet);
    document.getElementById('no-submit').addEventListener('click', submit);
  }

  function openSheet() { renderSheet(); document.getElementById('no-sheet').classList.add('open'); document.getElementById('no-backdrop').classList.add('open'); }
  function closeSheet() { document.getElementById('no-sheet').classList.remove('open'); document.getElementById('no-backdrop').classList.remove('open'); }

  function renderSheet() {
    const body = document.getElementById('no-sheet-body');
    const { list } = state();
    if (!list.length) { body.innerHTML = '<div class="empty-state"><div class="emoji">🛒</div><p>Dodajte izdelke.</p></div>'; return; }
    body.innerHTML = '';
    list.forEach((it) => {
      const line = document.createElement('div');
      line.className = 'cart-line';
      line.innerHTML = `
        <div class="cart-line-main">
          <div class="cart-line-name">${esc(it.name)}</div>
          <div class="cart-line-price">${formatPrice(it.price, tenant.currency)}</div>
          <input class="input cart-line-note" placeholder="Opomba" value="${esc(it.note || '')}" />
        </div>
        <div class="cart-line-right">
          <div class="stepper has-qty"><div class="qty-controls">
            <button class="step-btn minus">−</button><span class="step-qty">${it.qty}</span>
            <button class="step-btn add plus">＋</button>
          </div></div>
          <span class="line-total">${formatPrice(it.price * it.qty, tenant.currency)}</span>
        </div>`;
      line.querySelector('.plus').addEventListener('click', () => { cart[it.id].qty += 1; refresh(); renderSheet(); });
      line.querySelector('.minus').addEventListener('click', () => { removeItem(it.id); renderSheet(); });
      line.querySelector('.cart-line-note').addEventListener('input', (e) => { if (cart[it.id]) cart[it.id].note = e.target.value; });
      body.appendChild(line);
    });
  }

  function refresh() {
    const { count, total } = state();
    const bar = document.getElementById('no-cart-bar');
    if (bar) {
      document.getElementById('no-count').textContent = count;
      document.getElementById('no-total').textContent = formatPrice(total, tenant.currency);
      document.getElementById('no-sheet-total').textContent = formatPrice(total, tenant.currency);
      bar.classList.toggle('visible', count > 0);
    }
    document.querySelectorAll('#no-list .stepper').forEach((s) => s._update && s._update());
  }

  async function submit() {
    const { list, total } = state();
    if (!list.length) return;
    if (!selectedTableId) { toast('Izberite mizo.', 'error'); return; }
    const btn = document.getElementById('no-submit');
    btn.disabled = true; btn.textContent = 'Oddajam…';
    try {
      const note = document.getElementById('no-note').value.trim();
      const { data: order, error: oe } = await sb.from('orders').insert({
        tenant_id: tenant.id, table_id: selectedTableId, status: 'new',
        notes: note || null, total: Number(total.toFixed(2)),
      }).select().single();
      if (oe) throw oe;

      const rows = list.map((it) => ({
        order_id: order.id, menu_item_id: it.menu_item_id || it.id, tenant_id: tenant.id,
        item_name: it.name, item_price: it.price, quantity: it.qty, notes: it.note || null,
      }));
      const { error: ie } = await sb.from('order_items').insert(rows);
      if (ie) throw ie;

      // Clear the cart and refresh stock (a DB trigger already deducted it).
      Object.keys(cart).forEach((k) => delete cart[k]);
      document.getElementById('no-note').value = '';
      closeSheet();
      await load();              // re-read stock levels
      renderLayout();
      refresh();
      toast('✅ Naročilo oddano.', 'success');
    } catch (err) {
      console.error(err);
      toast('Napaka pri oddaji naročila.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Oddaj naročilo';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
