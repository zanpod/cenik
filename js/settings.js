// ============================================================================
// EPO.SI — Settings (tenant info, branding, sound, staff accounts)
// ============================================================================

(function () {
  let tenant = null;
  let profile = null;

  async function init() {
    const ctx = await AdminShell.init('settings', 'Nastavitve');
    if (!ctx) return;
    tenant = ctx.tenant;
    profile = ctx.profile;
    render();
    await loadStaff();
  }

  function render() {
    const isOwner = profile.role === 'owner' || profile.role === 'admin';
    document.getElementById('page-content').innerHTML = `
      <div class="card glass" style="margin-bottom:18px; max-width:620px">
        <h2 style="margin-top:0">Podatki restavracije</h2>
        <div class="field"><label>Ime</label><input class="input" id="s-name" value="${esc(tenant.name)}" /></div>
        <div class="field"><label>Oznaka (slug v URL)</label><input class="input" id="s-slug" value="${esc(tenant.slug)}" disabled /><div class="muted" style="font-size:.8rem;margin-top:4px">Oznake ni mogoče spreminjati (uporabljena v QR kodah).</div></div>
        <div class="field"><label>Logotip (URL)</label><input class="input" id="s-logo" value="${esc(tenant.logo_url || '')}" placeholder="https://…" /></div>
        <div class="field"><label>Naloži logotip</label><input class="input" type="file" id="s-logo-file" accept="image/*" /></div>
        <div class="row wrap">
          <div class="field" style="flex:1"><label>Primarna barva</label><input class="input" type="color" id="s-primary" value="${esc(tenant.primary_color || '#6B3FA0')}" style="height:48px;padding:4px" /></div>
          <div class="field" style="flex:1"><label>Sekundarna barva</label><input class="input" type="color" id="s-secondary" value="${esc(tenant.secondary_color || '#2E4A8B')}" style="height:48px;padding:4px" /></div>
          <div class="field" style="width:110px"><label>Valuta</label><input class="input" id="s-currency" value="${esc(tenant.currency || '€')}" /></div>
        </div>
        <label class="switch" style="margin:6px 0 18px"><input type="checkbox" id="s-sound" ${tenant.sound_enabled !== false ? 'checked' : ''}/><span class="track"></span><span>Zvočna obvestila ob novem naročilu</span></label>
        <button class="btn btn-primary" id="s-save">Shrani nastavitve</button>
      </div>

      <div class="card glass" style="max-width:620px">
        <h2 style="margin-top:0">Osebje</h2>
        <p class="muted">Povabite osebje. Po registraciji jih povežite z restavracijo.</p>
        <div id="staff-list"></div>
        ${isOwner ? `
        <div class="row wrap" style="margin-top:14px;align-items:flex-end">
          <div class="field" style="flex:1;margin:0"><label>E-pošta novega uporabnika</label><input class="input" type="email" id="invite-email" placeholder="ime@example.com" /></div>
          <div class="field" style="width:140px;margin:0"><label>Vloga</label>
            <select class="select" id="invite-role"><option value="staff">Osebje</option><option value="admin">Admin</option></select>
          </div>
          <button class="btn btn-primary" id="invite-btn">Povabi</button>
        </div>
        <div class="muted" style="font-size:.8rem;margin-top:8px">Povabilo pošlje e-pošto za potrditev. Po potrditvi se uporabnik samodejno poveže z vašo restavracijo.</div>
        ` : ''}
      </div>`;

    document.getElementById('s-save').addEventListener('click', save);
    const inviteBtn = document.getElementById('invite-btn');
    if (inviteBtn) inviteBtn.addEventListener('click', invite);
  }

  async function uploadLogo(file) {
    const ext = file.name.split('.').pop();
    const path = `${tenant.id}/logo-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from('menu-images').upload(path, file, { upsert: true });
    if (error) throw error;
    return sb.storage.from('menu-images').getPublicUrl(path).data.publicUrl;
  }

  async function save() {
    const btn = document.getElementById('s-save');
    btn.disabled = true; btn.textContent = 'Shranjujem…';
    try {
      let logo = document.getElementById('s-logo').value.trim() || null;
      const file = document.getElementById('s-logo-file').files[0];
      if (file) logo = await uploadLogo(file);

      const payload = {
        name: document.getElementById('s-name').value.trim(),
        logo_url: logo,
        primary_color: document.getElementById('s-primary').value,
        secondary_color: document.getElementById('s-secondary').value,
        currency: document.getElementById('s-currency').value.trim() || '€',
        sound_enabled: document.getElementById('s-sound').checked,
      };
      const { error } = await sb.from('tenants').update(payload).eq('id', tenant.id);
      if (error) throw error;
      tenant = { ...tenant, ...payload };
      applyBranding(tenant);
      toast('Nastavitve shranjene.', 'success');
    } catch (err) {
      console.error(err); toast('Napaka pri shranjevanju.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Shrani nastavitve';
    }
  }

  async function loadStaff() {
    const { data, error } = await sb.from('profiles').select('*').eq('tenant_id', tenant.id);
    const host = document.getElementById('staff-list');
    if (error || !data) { host.innerHTML = '<p class="muted">Ni mogoče naložiti osebja.</p>'; return; }
    host.innerHTML = data.map((p) => `
      <div class="list-card" style="background:var(--surface)">
        <div class="grow">
          <div class="title">${esc(p.full_name || '(brez imena)')}${p.id === profile.id ? ' <span class="muted">(vi)</span>' : ''}</div>
          <div class="sub">Vloga: ${esc(p.role)}</div>
        </div>
      </div>`).join('');
  }

  async function invite() {
    const email = document.getElementById('invite-email').value.trim();
    const role = document.getElementById('invite-role').value;
    if (!email) return toast('Vnesite e-pošto.', 'error');
    // Sign up the new user via an ISOLATED client so the admin's own session is
    // not replaced. They receive a confirmation email; the on_auth_user_created
    // DB trigger reads this metadata and links them to the tenant automatically.
    const tmp = window.supabase.createClient(
      SUPABASE_URL, SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    const { error } = await tmp.auth.signUp({
      email,
      password: crypto.randomUUID(),  // temporary; user resets via email
      options: { data: { invited_tenant_id: tenant.id, invited_role: role } },
    });
    if (error) { console.error(error); return toast('Napaka pri vabilu: ' + error.message, 'error'); }
    toast('Povabilo poslano na ' + email, 'success', 5000);
    document.getElementById('invite-email').value = '';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
