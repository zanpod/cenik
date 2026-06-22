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

      <div class="card glass" style="margin-bottom:18px; max-width:620px">
        <h2 style="margin-top:0">Izdajanje računov</h2>
        <p class="muted" style="margin-top:-4px">Podatki za račune po slovenski zakonodaji (ZDDV-1). Davčno potrjevanje (FURS) je v testnem načinu izklopljeno — računi so označeni kot <strong>testni / ni davčno potrjen</strong>.</p>
        <div class="field"><label>Naziv firme (na računu)</label><input class="input" id="s-business" value="${esc(tenant.business_name || '')}" placeholder="npr. Bar Lipa, Janez Novak s.p." /></div>
        <div class="field"><label>Naslov sedeža</label><input class="input" id="s-address" value="${esc(tenant.address || '')}" placeholder="Ulica 1, 1000 Ljubljana" /></div>
        <div class="row wrap">
          <div class="field" style="flex:1"><label>Davčna številka</label><input class="input" id="s-tax" value="${esc(tenant.tax_number || '')}" placeholder="12345678" /></div>
          <div class="field" style="width:150px"><label>Privzeta stopnja DDV (%)</label><input class="input" type="number" step="0.5" id="s-vatrate" value="${tenant.default_vat_rate ?? 22}" /></div>
        </div>
        <label class="switch" style="margin:6px 0 14px"><input type="checkbox" id="s-vatreg" ${tenant.vat_registered ? 'checked' : ''}/><span class="track"></span><span>Zavezanec za DDV</span></label>
        <div class="row wrap">
          <div class="field" style="flex:1"><label>Oznaka poslovnega prostora</label><input class="input" id="s-premise" value="${esc(tenant.premise_label || 'P1')}" /></div>
          <div class="field" style="flex:1"><label>Oznaka blagajne</label><input class="input" id="s-device" value="${esc(tenant.device_label || 'BL1')}" /></div>
        </div>
        <div class="muted" style="font-size:.8rem;margin-bottom:14px">Številka računa bo oblike <code>${esc(tenant.premise_label || 'P1')}-${esc(tenant.device_label || 'BL1')}-N</code> (zaporedno, brez vrzeli).</div>
        <button class="btn btn-primary" id="s-save-fiscal">Shrani podatke za račune</button>
      </div>

      <div class="card glass" style="margin-bottom:18px; max-width:620px">
        <h2 style="margin-top:0">Davčno potrjevanje (FURS)</h2>
        <p class="muted" style="margin-top:-4px">Ko je vklopljeno, se ob izdaji računa pridobita <strong>ZOI in EOR</strong> ter QR koda prek strežniške funkcije (zahteva nastavljen certifikat — glej <code>supabase/functions/README.md</code>). Če certifikat ni nastavljen, izdaja ostane testna (nepotrjena).</p>
        <label class="switch" style="margin:6px 0 14px"><input type="checkbox" id="s-fiscal-enabled" ${tenant.fiscal_enabled ? 'checked' : ''}/><span class="track"></span><span>Vklopi davčno potrjevanje</span></label>
        <div class="row wrap">
          <button class="btn btn-primary" id="s-save-furs">Shrani</button>
          <button class="btn" id="s-register-premise">Registriraj poslovni prostor (FURS)</button>
        </div>
        <div class="muted" style="font-size:.8rem;margin-top:10px">⚠️ TEST okolje: nastavite <code>FURS_ENV=test</code> in testni certifikat. Pred prvim računom enkrat registrirajte poslovni prostor. Računi v testu niso pravno veljavni.</div>
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
    document.getElementById('s-save-fiscal').addEventListener('click', saveFiscal);
    document.getElementById('s-save-furs').addEventListener('click', saveFurs);
    document.getElementById('s-register-premise').addEventListener('click', registerPremise);
    const inviteBtn = document.getElementById('invite-btn');
    if (inviteBtn) inviteBtn.addEventListener('click', invite);
  }

  async function saveFurs() {
    const btn = document.getElementById('s-save-furs');
    btn.disabled = true; btn.textContent = 'Shranjujem…';
    try {
      const enabled = document.getElementById('s-fiscal-enabled').checked;
      const { error } = await sb.from('tenants').update({ fiscal_enabled: enabled }).eq('id', tenant.id);
      if (error) throw error;
      tenant.fiscal_enabled = enabled;
      toast(enabled ? 'Davčno potrjevanje vklopljeno.' : 'Davčno potrjevanje izklopljeno.', 'success');
    } catch (err) {
      console.error(err); toast('Napaka pri shranjevanju.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Shrani';
    }
  }

  async function registerPremise() {
    if (!confirm('Registriram poslovni prostor pri FURS? (Potrebno enkrat pred prvim računom.)')) return;
    const btn = document.getElementById('s-register-premise');
    btn.disabled = true; btn.textContent = 'Registriram…';
    try {
      // Za TEST: premična naprava (C). Za fiksni prostor uporabite real_estate
      // podatke (kataster) — glej supabase/functions/README.md.
      const { data, error } = await sb.functions.invoke('furs-register-premise', { body: { movable_type: 'C' } });
      if (error) throw error;
      if (data && data.error) throw new Error(data.message || data.error);
      toast('Poslovni prostor registriran pri FURS.', 'success', 5000);
    } catch (err) {
      console.error(err);
      toast('Registracija ni uspela: ' + (err.message || ''), 'error', 7000);
    } finally {
      btn.disabled = false; btn.textContent = 'Registriraj poslovni prostor (FURS)';
    }
  }

  async function saveFiscal() {
    const btn = document.getElementById('s-save-fiscal');
    btn.disabled = true; btn.textContent = 'Shranjujem…';
    try {
      const payload = {
        business_name: document.getElementById('s-business').value.trim() || null,
        address: document.getElementById('s-address').value.trim() || null,
        tax_number: document.getElementById('s-tax').value.trim() || null,
        vat_registered: document.getElementById('s-vatreg').checked,
        default_vat_rate: Number(document.getElementById('s-vatrate').value) || 22,
        premise_label: document.getElementById('s-premise').value.trim() || 'P1',
        device_label: document.getElementById('s-device').value.trim() || 'BL1',
      };
      const { error } = await sb.from('tenants').update(payload).eq('id', tenant.id);
      if (error) throw error;
      tenant = { ...tenant, ...payload };
      toast('Podatki za račune shranjeni.', 'success');
    } catch (err) {
      console.error(err); toast('Napaka pri shranjevanju.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Shrani podatke za račune';
    }
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
