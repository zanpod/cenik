// ============================================================================
// EPO.SI — Live orders dashboard with Supabase Realtime
// ============================================================================

(function () {
  let tenant = null;
  let orders = [];           // array of order objects with .items[]
  let tablesById = {};
  let activeFilter = 'new';  // new | preparing | served | today
  let soundEnabled = true;
  let timeTimer = null;

  const FILTERS = [
    { key: 'new',       label: 'Nova naročila' },
    { key: 'preparing', label: 'V pripravi' },
    { key: 'served',    label: 'Postrežena' },
    { key: 'today',     label: 'Vsa danes' },
  ];

  async function init() {
    const ctx = await AdminShell.init('dashboard', 'Naročila');
    if (!ctx) return;
    tenant = ctx.tenant;
    soundEnabled = tenant.sound_enabled !== false;

    renderHeaderActions();
    renderLayout();
    await loadTables();
    await loadOrders();
    subscribeRealtime();
    requestNotifyPermission();

    // Refresh "time ago" labels every 30s.
    timeTimer = setInterval(updateTimes, 30000);
  }

  function renderHeaderActions() {
    document.getElementById('header-actions').innerHTML = `
      <button class="btn btn-sm" id="sound-toggle"></button>
      <button class="btn btn-sm" id="refresh-btn">🔄 Osveži</button>`;
    updateSoundBtn();
    document.getElementById('sound-toggle').addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      updateSoundBtn();
      // Unlock audio on user gesture
      AudioChime.unlock();
    });
    document.getElementById('refresh-btn').addEventListener('click', loadOrders);
  }

  function updateSoundBtn() {
    const b = document.getElementById('sound-toggle');
    if (b) b.textContent = soundEnabled ? '🔔 Zvok vklopljen' : '🔕 Zvok izklopljen';
  }

  function renderLayout() {
    document.getElementById('page-content').innerHTML = `
      <div class="filter-tabs" id="filter-tabs"></div>
      <div id="orders-host"></div>`;
    renderFilterTabs();
  }

  function renderFilterTabs() {
    const host = document.getElementById('filter-tabs');
    host.innerHTML = FILTERS.map((f) => `
      <button class="filter-tab ${f.key === activeFilter ? 'active' : ''}" data-key="${f.key}">
        ${f.label} <span class="count" id="count-${f.key}">0</span>
      </button>`).join('');
    host.querySelectorAll('.filter-tab').forEach((t) => {
      t.addEventListener('click', () => { activeFilter = t.dataset.key; renderFilterTabs(); renderOrders(); });
    });
    updateCounts();
  }

  async function loadTables() {
    const { data } = await sb.from('tables').select('*').eq('tenant_id', tenant.id);
    tablesById = {};
    (data || []).forEach((t) => { tablesById[t.id] = t; });
  }

  async function loadOrders() {
    // Live dashboard: only orders from the last 24h (auto-archive older ones).
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data, error } = await sb
      .from('orders')
      .select('*, order_items(*)')
      .eq('tenant_id', tenant.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false });
    if (error) { console.error(error); toast('Napaka pri nalaganju naročil.', 'error'); return; }
    orders = (data || []).map((o) => ({ ...o, items: o.order_items || [] }));
    renderOrders();
    updateCounts();
  }

  function filteredOrders() {
    if (activeFilter === 'today') {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return orders.filter((o) => new Date(o.created_at) >= start);
    }
    return orders.filter((o) => o.status === activeFilter);
  }

  function updateCounts() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const counts = {
      new: orders.filter((o) => o.status === 'new').length,
      preparing: orders.filter((o) => o.status === 'preparing').length,
      served: orders.filter((o) => o.status === 'served').length,
      today: orders.filter((o) => new Date(o.created_at) >= start).length,
    };
    Object.entries(counts).forEach(([k, v]) => {
      const el = document.getElementById(`count-${k}`);
      if (el) el.textContent = v;
    });
    AdminShell.setBadge('dashboard', counts.new);
    // Tab title shows pending count
    document.title = counts.new > 0 ? `(${counts.new}) Naročila — EPO.SI` : 'Naročila — EPO.SI';
  }

  function renderOrders(flashId) {
    const host = document.getElementById('orders-host');
    const list = filteredOrders();
    if (!list.length) {
      host.innerHTML = '<div class="empty-state"><div class="emoji">🎉</div><p>Ni naročil v tej kategoriji.</p></div>';
      return;
    }
    host.innerHTML = `<div class="orders-grid">${list.map(orderCard).join('')}</div>`;
    wireOrderActions();
    if (flashId) {
      const card = host.querySelector(`[data-order="${flashId}"]`);
      if (card) card.classList.add('flash');
    }
  }

  function orderCard(o) {
    const table = tablesById[o.table_id];
    const label = table ? (table.label || `Miza ${table.table_number}`) : 'Miza ?';
    const tnum = table ? table.table_number : '?';
    const items = o.items.map((it) => `
      <div class="order-item-row">
        <span class="order-item-qty">${it.quantity}×</span>
        <span class="order-item-name">${esc(it.item_name)}${it.notes ? `<div class="order-item-note">↳ ${esc(it.notes)}</div>` : ''}</span>
      </div>`).join('');

    let actions = '';
    if (o.status === 'new') {
      actions = `
        <button class="btn btn-warning btn-sm" data-act="preparing" data-id="${o.id}">V pripravo</button>
        <button class="btn btn-danger btn-sm" data-act="cancelled" data-id="${o.id}">Prekliči</button>`;
    } else if (o.status === 'preparing') {
      actions = `
        <button class="btn btn-success btn-sm" data-act="served" data-id="${o.id}">Postreženo</button>
        <button class="btn btn-danger btn-sm" data-act="cancelled" data-id="${o.id}">Prekliči</button>`;
    } else if (o.status === 'served') {
      actions = `<button class="btn btn-sm" data-act="preparing" data-id="${o.id}">↩ V pripravo</button>`;
    }

    return `
      <div class="order-card glass" data-order="${o.id}">
        <div class="order-card-head">
          <div class="order-table-num" title="${esc(label)}">${esc(String(tnum))}</div>
          <div class="order-meta">
            <strong>${esc(label)}</strong>
            <span class="order-time" data-time="${o.created_at}">${timeAgo(o.created_at)}</span>
          </div>
          <span class="badge badge-${o.status}">${STATUS_LABELS[o.status]}</span>
        </div>
        <div class="order-items-list">${items}</div>
        ${o.notes ? `<div class="order-note-box">📝 ${esc(o.notes)}</div>` : ''}
        <div class="row">
          <span class="order-total">${formatPrice(o.total, tenant.currency)}</span>
          <span class="muted" style="margin-left:auto">${formatTime(o.created_at)}</span>
        </div>
        ${actions ? `<div class="order-actions">${actions}</div>` : ''}
      </div>`;
  }

  function wireOrderActions() {
    document.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const status = btn.dataset.act;
        btn.disabled = true;
        const { error } = await sb.from('orders').update({ status }).eq('id', id);
        if (error) { console.error(error); toast('Napaka pri posodobitvi.', 'error'); btn.disabled = false; return; }
        const o = orders.find((x) => x.id === id);
        if (o) o.status = status;
        renderOrders();
        updateCounts();
      });
    });
  }

  function updateTimes() {
    document.querySelectorAll('[data-time]').forEach((el) => {
      el.textContent = timeAgo(el.dataset.time);
    });
  }

  // --- Realtime -------------------------------------------------------------
  function subscribeRealtime() {
    sb.channel('orders-' + tenant.id)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'orders',
        filter: `tenant_id=eq.${tenant.id}`,
      }, async (payload) => {
        const o = payload.new;
        // Fetch its items (they arrive separately, may not be inserted yet)
        await new Promise((r) => setTimeout(r, 350));
        const { data: its } = await sb.from('order_items').select('*').eq('order_id', o.id);
        if (orders.some((x) => x.id === o.id)) return;
        orders.unshift({ ...o, items: its || [] });
        updateCounts();
        renderOrders(o.id);
        notifyNewOrder(o);
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'orders',
        filter: `tenant_id=eq.${tenant.id}`,
      }, (payload) => {
        const idx = orders.findIndex((x) => x.id === payload.new.id);
        if (idx >= 0) {
          orders[idx] = { ...orders[idx], ...payload.new };
          updateCounts();
          renderOrders();
        }
      })
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'order_items',
        filter: `tenant_id=eq.${tenant.id}`,
      }, (payload) => {
        const o = orders.find((x) => x.id === payload.new.order_id);
        if (o && !o.items.some((i) => i.id === payload.new.id)) {
          o.items.push(payload.new);
          renderOrders();
        }
      })
      .subscribe();
  }

  // --- Notifications --------------------------------------------------------
  function notifyNewOrder(o) {
    const table = tablesById[o.table_id];
    const label = table ? (table.label || `Miza ${table.table_number}`) : 'Miza';
    if (soundEnabled) AudioChime.play();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('🔔 Novo naročilo', {
          body: `${label} — ${formatPrice(o.total, tenant.currency)}`,
          tag: o.id,
        });
      } catch {}
    }
    toast(`🔔 Novo naročilo — ${label}`, 'success', 4000);
  }

  function requestNotifyPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  // --- Chime (Web Audio API fallback + <audio> file) ------------------------
  const AudioChime = (() => {
    let ctxA = null;
    let audioEl = null;
    let unlocked = false;

    function ensure() {
      if (!audioEl) {
        audioEl = new Audio('/assets/notification.wav');
        audioEl.preload = 'auto';
      }
    }
    function unlock() {
      ensure();
      unlocked = true;
      // Prime the audio element so later playback isn't blocked.
      audioEl.play().then(() => { audioEl.pause(); audioEl.currentTime = 0; }).catch(() => {});
    }
    function play() {
      ensure();
      audioEl.currentTime = 0;
      audioEl.play().catch(() => beep());
    }
    // Synthesised pleasant two-note chime if the mp3 can't play.
    function beep() {
      try {
        ctxA = ctxA || new (window.AudioContext || window.webkitAudioContext)();
        const now = ctxA.currentTime;
        [880, 1320].forEach((freq, i) => {
          const osc = ctxA.createOscillator();
          const gain = ctxA.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const t0 = now + i * 0.16;
          gain.gain.setValueAtTime(0, t0);
          gain.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
          osc.connect(gain); gain.connect(ctxA.destination);
          osc.start(t0); osc.stop(t0 + 0.42);
        });
      } catch {}
    }
    return { play, unlock };
  })();

  // Unlock audio on first interaction anywhere (browsers block autoplay).
  ['click', 'touchstart', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => AudioChime.unlock(), { once: true }));

  document.addEventListener('DOMContentLoaded', init);
})();
