// ============================================================================
// EPO.SI — Customer menu logic
// Reads tenant slug from path (/menu/<slug>) and qr_code_token from ?table=
// ============================================================================

(function () {
  const sb = window.sb;
  let tenant = null;
  let table = null;
  let categories = [];
  let menuItems = [];
  let activeCategoryId = null;

  // --- Parse URL ------------------------------------------------------------
  function parseUrl() {
    // Path like /menu/bar-lipa  (Netlify rewrites /menu/* -> /menu/index.html)
    const parts = location.pathname.split('/').filter(Boolean); // ["menu","bar-lipa"]
    const slug = parts[1] || new URLSearchParams(location.search).get('tenant');
    const token = new URLSearchParams(location.search).get('table');
    return { slug, token };
  }

  function showError(title, msg) {
    document.getElementById('loading-state').classList.add('hidden');
    document.getElementById('menu-app').classList.add('hidden');
    const el = document.getElementById('error-state');
    el.classList.remove('hidden');
    if (title) document.getElementById('error-title').textContent = title;
    if (msg) document.getElementById('error-msg').textContent = msg;
  }

  // --- Load everything ------------------------------------------------------
  async function init() {
    setupOffline();
    const { slug, token } = parseUrl();

    if (!slug) { return showError('Restavracija ni najdena', 'Manjka oznaka restavracije v povezavi.'); }
    if (!token) { return showError('QR koda ni veljavna', 'Prosimo, skenirajte kodo na vaši mizi.'); }

    Cart.setScope(slug, token);

    try {
      // Tenant
      const { data: t, error: te } = await sb
        .from('tenants').select('*').eq('slug', slug).eq('is_active', true).maybeSingle();
      if (te) throw te;
      if (!t) return showError('Restavracija ni najdena', 'Ta restavracija ni na voljo.');
      tenant = t;
      applyBranding(tenant);

      // Table (validate token belongs to tenant)
      const { data: tb, error: tbe } = await sb
        .from('tables').select('*')
        .eq('qr_code_token', token).eq('tenant_id', tenant.id).eq('is_active', true)
        .maybeSingle();
      if (tbe) throw tbe;
      if (!tb) return showError('QR koda ni veljavna', 'Prosimo, skenirajte kodo na vaši mizi.');
      table = tb;

      // Categories + items in parallel
      const [catRes, itemRes] = await Promise.all([
        sb.from('categories').select('*')
          .eq('tenant_id', tenant.id).eq('is_active', true)
          .order('sort_order', { ascending: true }),
        sb.from('menu_items').select('*')
          .eq('tenant_id', tenant.id)
          .order('sort_order', { ascending: true }),
      ]);
      if (catRes.error) throw catRes.error;
      if (itemRes.error) throw itemRes.error;
      categories = catRes.data || [];
      menuItems = itemRes.data || [];

      renderHeader();
      renderTabs();
      renderItems();
      wireCart();
      document.getElementById('loading-state').classList.add('hidden');
      document.getElementById('menu-app').classList.remove('hidden');
    } catch (err) {
      console.error(err);
      showError('Napaka pri nalaganju', 'Prišlo je do napake. Poskusite znova.');
    }
  }

  // --- Render header --------------------------------------------------------
  function renderHeader() {
    document.getElementById('tenant-name').textContent = tenant.name;
    const logo = document.getElementById('tenant-logo');
    if (tenant.logo_url) {
      logo.src = tenant.logo_url;
      logo.classList.remove('hidden', 'placeholder');
    }
    const label = table.label || `Miza ${table.table_number}`;
    document.getElementById('table-label').textContent = label;
    document.title = `${tenant.name} — Meni`;
  }

  // --- Category tabs --------------------------------------------------------
  function renderTabs() {
    const host = document.getElementById('cat-tabs');
    host.innerHTML = '';
    if (!categories.length) return;
    activeCategoryId = categories[0].id;
    categories.forEach((c) => {
      const tab = document.createElement('button');
      tab.className = 'cat-tab' + (c.id === activeCategoryId ? ' active' : '');
      tab.innerHTML = `${c.icon ? esc(c.icon) + ' ' : ''}<span>${esc(c.name)}</span>`;
      tab.dataset.cat = c.id;
      tab.addEventListener('click', () => {
        activeCategoryId = c.id;
        document.querySelectorAll('.cat-tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === c.id));
        const heading = document.getElementById(`cat-${c.id}`);
        if (heading) heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      host.appendChild(tab);
    });
  }

  // --- Menu items -----------------------------------------------------------
  function renderItems() {
    const host = document.getElementById('menu-list');
    host.innerHTML = '';
    if (!menuItems.length) {
      host.innerHTML = '<div class="empty-state"><div class="emoji">🍽️</div><p>Meni je trenutno prazen.</p></div>';
      return;
    }

    categories.forEach((cat) => {
      const inCat = menuItems.filter((m) => m.category_id === cat.id);
      if (!inCat.length) return;
      const heading = document.createElement('h2');
      heading.className = 'cat-heading';
      heading.id = `cat-${cat.id}`;
      heading.innerHTML = `${cat.icon ? esc(cat.icon) + ' ' : ''}${esc(cat.name)}`;
      host.appendChild(heading);
      inCat.forEach((item) => host.appendChild(renderItemCard(item)));
    });

    // Uncategorised items
    const orphans = menuItems.filter((m) => !categories.some((c) => c.id === m.category_id));
    if (orphans.length) {
      const heading = document.createElement('h2');
      heading.className = 'cat-heading';
      heading.textContent = 'Ostalo';
      host.appendChild(heading);
      orphans.forEach((item) => host.appendChild(renderItemCard(item)));
    }

    // Highlight active tab while scrolling
    observeScroll();
  }

  function renderItemCard(item) {
    // Sold out when stock tracking is on and stock is depleted.
    const soldOut = item.track_stock && item.stock_quantity <= 0;
    const orderable = item.is_available && !soldOut;

    const card = document.createElement('div');
    card.className = 'menu-item glass' + (orderable ? '' : ' unavailable');
    card.dataset.id = item.id;

    const thumb = item.image_url
      ? `<img class="item-thumb" loading="lazy" src="${esc(item.image_url)}" alt="${esc(item.name)}" />`
      : `<div class="item-thumb placeholder">🍽️</div>`;

    const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
    const qty = Cart.quantityOf(item.id);
    let controls;
    if (!orderable) controls = `<span class="na-badge">${soldOut ? 'Razprodano' : 'Ni na voljo'}</span>`;
    else if (hasVariants) controls = `
      <div class="variant-row">${item.variants.map((v, i) => `
        <button class="variant-chip" data-vi="${i}">${esc(v.name)} · ${formatPrice(v.price, tenant.currency)}</button>`).join('')}</div>`;
    else controls = `
      <div class="stepper${qty > 0 ? ' has-qty' : ''}" data-id="${item.id}">
        <button class="step-btn add add-only" aria-label="Dodaj">＋</button>
        <div class="qty-controls">
          <button class="step-btn minus" aria-label="Odstrani">−</button>
          <span class="step-qty">${qty}</span>
          <button class="step-btn add plus" aria-label="Dodaj">＋</button>
        </div>
      </div>`;

    card.innerHTML = `
      ${thumb}
      <div class="item-main">
        <div class="item-name">${esc(item.name)}</div>
        ${item.description ? `<div class="item-desc">${esc(item.description)}</div>` : ''}
        ${item.allergens ? `<div class="item-allergens">⚠️ ${esc(item.allergens)}</div>` : ''}
        <div class="item-bottom">
          <span class="item-price">${hasVariants ? 'od ' : ''}${formatPrice(hasVariants ? Math.min(...item.variants.map((v) => v.price)) : item.price, tenant.currency)}</span>
          ${controls}
        </div>
      </div>`;

    if (orderable && hasVariants) {
      card.querySelectorAll('.variant-chip').forEach((chip) => chip.addEventListener('click', () => {
        const v = item.variants[Number(chip.dataset.vi)];
        Cart.add({ id: `${item.id}|${v.name}`, menu_item_id: item.id, name: `${item.name} – ${v.name}`, price: v.price });
        pulse(card);
      }));
    } else if (orderable) {
      const stepper = card.querySelector('.stepper');
      const addItem = () => {
        // Do not let a customer order more than the available stock.
        if (item.track_stock && Cart.quantityOf(item.id) + 1 > item.stock_quantity) {
          toast(`Na voljo le še ${item.stock_quantity} kos.`, 'error');
          return;
        }
        Cart.add(item); pulse(card);
      };
      card.querySelector('.add-only').addEventListener('click', addItem);
      card.querySelector('.plus').addEventListener('click', addItem);
      card.querySelector('.minus').addEventListener('click', () => Cart.remove(item.id));
      stepper._update = () => {
        const q = Cart.quantityOf(item.id);
        stepper.classList.toggle('has-qty', q > 0);
        stepper.querySelector('.step-qty').textContent = q;
      };
    }
    return card;
  }

  function pulse(el) {
    el.style.transition = 'transform .12s';
    el.style.transform = 'scale(0.98)';
    setTimeout(() => { el.style.transform = ''; }, 120);
  }

  // Highlight tab matching the section in view
  function observeScroll() {
    const headings = categories
      .map((c) => document.getElementById(`cat-${c.id}`))
      .filter(Boolean);
    if (!headings.length || !('IntersectionObserver' in window)) return;
    const obs = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      const id = visible.target.id.replace('cat-', '');
      document.querySelectorAll('.cat-tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === id));
    }, { rootMargin: '-30% 0px -60% 0px' });
    headings.forEach((h) => obs.observe(h));
  }

  // --- Cart wiring ----------------------------------------------------------
  function wireCart() {
    const bar = document.getElementById('cart-bar');
    const sheet = document.getElementById('cart-sheet');
    const backdrop = document.getElementById('sheet-backdrop');

    Cart.onChange((state) => {
      document.getElementById('cart-bar-count').textContent = state.count;
      document.getElementById('cart-bar-total').textContent = formatPrice(state.total, tenant?.currency);
      document.getElementById('sheet-total').textContent = formatPrice(state.total, tenant?.currency);
      bar.classList.toggle('visible', state.count > 0);
      // Update steppers in the list
      document.querySelectorAll('.stepper').forEach((s) => s._update && s._update());
      if (sheet.classList.contains('open')) renderSheet();
    });

    const openSheet = () => {
      renderSheet();
      sheet.classList.add('open');
      backdrop.classList.add('open');
    };
    const closeSheet = () => {
      sheet.classList.remove('open');
      backdrop.classList.remove('open');
    };

    bar.addEventListener('click', openSheet);
    document.getElementById('sheet-close').addEventListener('click', closeSheet);
    backdrop.addEventListener('click', closeSheet);
    document.getElementById('submit-order').addEventListener('click', submitOrder);
    document.getElementById('confirm-again').addEventListener('click', () => {
      document.getElementById('confirm-overlay').classList.remove('open');
    });
  }

  function renderSheet() {
    const body = document.getElementById('sheet-body');
    const { items } = Cart.getState();
    if (!items.length) {
      body.innerHTML = '<div class="empty-state"><div class="emoji">🛒</div><p>Košarica je prazna.</p></div>';
      document.getElementById('submit-order').disabled = true;
      return;
    }
    document.getElementById('submit-order').disabled = false;
    body.innerHTML = '';
    items.forEach((it) => {
      const line = document.createElement('div');
      line.className = 'cart-line';
      line.innerHTML = `
        <div class="cart-line-main">
          <div class="cart-line-name">${esc(it.name)}</div>
          <div class="cart-line-price">${formatPrice(it.price, tenant.currency)}</div>
          <input class="input cart-line-note" placeholder="Opomba (npr. brez ledu)" value="${esc(it.note || '')}" />
        </div>
        <div class="cart-line-right">
          <div class="stepper has-qty">
            <div class="qty-controls">
              <button class="step-btn minus" aria-label="Odstrani">−</button>
              <span class="step-qty">${it.quantity}</span>
              <button class="step-btn add plus" aria-label="Dodaj">＋</button>
            </div>
          </div>
          <span class="line-total">${formatPrice(it.price * it.quantity, tenant.currency)}</span>
        </div>`;
      line.querySelector('.plus').addEventListener('click', () => Cart.add({ id: it.id, name: it.name, price: it.price }));
      line.querySelector('.minus').addEventListener('click', () => Cart.remove(it.id));
      line.querySelector('.cart-line-note').addEventListener('input', (e) => Cart.setNote(it.id, e.target.value));
      body.appendChild(line);
    });
  }

  // --- Submit order ---------------------------------------------------------
  async function submitOrder() {
    const { items, total } = Cart.getState();
    if (!items.length) return;
    const btn = document.getElementById('submit-order');
    btn.disabled = true;
    btn.textContent = 'Pošiljam…';

    const orderNote = document.getElementById('order-note').value.trim();

    try {
      // Generate the order id client-side: anonymous customers may INSERT but
      // not SELECT orders (per RLS), so we must not request the row back via
      // .select() — that would require read access and fail.
      const orderId = (crypto.randomUUID && crypto.randomUUID()) ||
        ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        }));

      const { error: oe } = await sb.from('orders').insert({
        id: orderId,
        tenant_id: tenant.id,
        table_id: table.id,
        status: 'new',
        notes: orderNote || null,
        total: Number(total.toFixed(2)),
      });
      if (oe) throw oe;

      const rows = items.map((it) => ({
        order_id: orderId,
        menu_item_id: it.menu_item_id || it.id,
        tenant_id: tenant.id,
        item_name: it.name,
        item_price: it.price,
        quantity: it.quantity,
        notes: it.note || null,
      }));
      const { error: ie } = await sb.from('order_items').insert(rows);
      if (ie) throw ie;

      // Success
      Cart.clear();
      document.getElementById('order-note').value = '';
      document.getElementById('cart-sheet').classList.remove('open');
      document.getElementById('sheet-backdrop').classList.remove('open');
      const label = table.label || `Miza ${table.table_number}`;
      document.getElementById('confirm-msg').textContent =
        `Vaše naročilo z mize "${label}" je bilo uspešno oddano. Hvala!`;
      document.getElementById('confirm-overlay').classList.add('open');
    } catch (err) {
      console.error(err);
      toast('Napaka pri pošiljanju naročila. Poskusite znova.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Pošlji naročilo';
    }
  }

  // --- Offline handling -----------------------------------------------------
  function setupOffline() {
    const banner = document.getElementById('offline-banner');
    const update = () => banner.classList.toggle('show', !navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
