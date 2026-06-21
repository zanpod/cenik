// ============================================================================
// EPO.SI — Admin auth guard + shared shell (sidebar / bottom tabs / header)
// Every admin page (except the login page) calls AdminShell.init().
// ============================================================================

const NAV = [
  { href: '/admin/dashboard.html', icon: '📋', label: 'Naročila', key: 'dashboard', badge: true },
  { href: '/admin/new-order.html', icon: '➕', label: 'Novo',     key: 'neworder' },
  { href: '/admin/menu.html',      icon: '🍽️', label: 'Meni',     key: 'menu' },
  { href: '/admin/tables.html',    icon: '🪑', label: 'Mize',     key: 'tables' },
  { href: '/admin/orders.html',    icon: '🧾', label: 'Zgodovina', key: 'orders' },
  { href: '/admin/settings.html',  icon: '⚙️', label: 'Nastavitve', key: 'settings' },
];

const AdminShell = (() => {
  let profile = null;
  let tenant = null;

  // Require an authenticated session. Returns { profile, tenant } or redirects.
  async function requireAuth() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      location.replace('/admin/');
      return null;
    }
    const { data: prof, error } = await sb
      .from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) console.error(error);
    if (!prof || !prof.tenant_id) {
      toast('Vaš račun ni povezan z restavracijo.', 'error', 6000);
      return null;
    }
    profile = prof;
    const { data: t } = await sb.from('tenants').select('*').eq('id', prof.tenant_id).maybeSingle();
    tenant = t;
    applyBranding(tenant);
    return { profile, tenant, user: session.user };
  }

  // Render sidebar + bottom tabs + header into the page.
  function render(activeKey, title) {
    const shell = document.getElementById('admin-shell');
    if (!shell) return;

    const navLinks = NAV.map((n) => `
      <a class="nav-link ${n.key === activeKey ? 'active' : ''}" href="${n.href}">
        <span class="icon">${n.icon}</span>
        <span>${n.label}</span>
        ${n.badge ? `<span class="pill hidden" id="nav-badge-${n.key}"></span>` : ''}
      </a>`).join('');

    const bottomLinks = NAV.map((n) => `
      <a class="${n.key === activeKey ? 'active' : ''}" href="${n.href}" style="position:relative">
        <span class="icon">${n.icon}</span>
        <span>${n.label}</span>
        ${n.badge ? `<span class="pill hidden" id="tab-badge-${n.key}"></span>` : ''}
      </a>`).join('');

    shell.innerHTML = `
      <aside class="sidebar">
        <div class="sidebar-logo">EPO.SI</div>
        <div class="sidebar-tenant">${esc(tenant?.name || '')}</div>
        ${navLinks}
        <div class="sidebar-footer">
          <button class="btn btn-ghost btn-block" id="logout-btn">🚪 Odjava</button>
        </div>
      </aside>
      <main class="admin-main">
        <div class="admin-header">
          <h1>${esc(title)}</h1>
          <div class="spacer"></div>
          <div id="header-actions" class="row wrap"></div>
        </div>
        <div id="page-content"></div>
      </main>
      <nav class="bottom-tabs">${bottomLinks}</nav>`;

    document.getElementById('logout-btn').addEventListener('click', logout);
  }

  function setBadge(key, count) {
    ['nav-badge-', 'tab-badge-'].forEach((p) => {
      const el = document.getElementById(p + key);
      if (!el) return;
      if (count > 0) { el.textContent = count; el.classList.remove('hidden'); }
      else el.classList.add('hidden');
    });
  }

  async function logout() {
    await sb.auth.signOut();
    location.replace('/admin/');
  }

  // Convenience: full init for a page.
  async function init(activeKey, title) {
    const ctx = await requireAuth();
    if (!ctx) return null;
    render(activeKey, title);
    return ctx;
  }

  return { requireAuth, render, init, setBadge, logout,
    get profile() { return profile; }, get tenant() { return tenant; } };
})();

window.AdminShell = AdminShell;
