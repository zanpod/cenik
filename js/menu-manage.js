// ============================================================================
// EPO.SI — Menu management (categories + items CRUD, image upload, reorder)
// ============================================================================

(function () {
  let tenant = null;
  let categories = [];
  let items = [];
  let editingCatId = null;
  let editingItemId = null;

  async function init() {
    const ctx = await AdminShell.init('menu', 'Upravljanje menija');
    if (!ctx) return;
    tenant = ctx.tenant;
    document.getElementById('header-actions').innerHTML = `
      <button class="btn btn-sm" id="add-cat">＋ Kategorija</button>
      <button class="btn btn-primary btn-sm" id="add-item">＋ Izdelek</button>`;
    document.getElementById('add-cat').addEventListener('click', () => openCatModal());
    document.getElementById('add-item').addEventListener('click', () => openItemModal());
    wireModals();
    await load();
  }

  async function load() {
    const [c, i] = await Promise.all([
      sb.from('categories').select('*').eq('tenant_id', tenant.id).order('sort_order'),
      sb.from('menu_items').select('*').eq('tenant_id', tenant.id).order('sort_order'),
    ]);
    categories = c.data || [];
    items = i.data || [];
    render();
  }

  function render() {
    const host = document.getElementById('page-content');
    if (!categories.length && !items.length) {
      host.innerHTML = '<div class="empty-state"><div class="emoji">🍽️</div><p>Začnite z dodajanjem kategorije.</p></div>';
      return;
    }
    let html = '';
    categories.forEach((cat, idx) => {
      const inCat = items.filter((it) => it.category_id === cat.id);
      html += `
        <div class="card glass" style="margin-bottom:18px">
          <div class="row" style="margin-bottom:10px">
            <strong style="font-size:1.15rem">${esc(cat.icon || '')} ${esc(cat.name)}</strong>
            ${cat.is_active ? '' : '<span class="badge badge-cancelled">Skrita</span>'}
            <div class="spacer"></div>
            <button class="btn btn-sm btn-icon" data-cat-up="${cat.id}" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn btn-sm btn-icon" data-cat-down="${cat.id}" ${idx === categories.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn btn-sm" data-cat-edit="${cat.id}">Uredi</button>
            <button class="btn btn-sm btn-danger" data-cat-del="${cat.id}">Izbriši</button>
          </div>
          ${inCat.length ? inCat.map((it, ii) => itemRow(it, ii, inCat.length)).join('') :
            '<p class="muted" style="margin:0">Ni izdelkov v tej kategoriji.</p>'}
        </div>`;
    });

    const orphans = items.filter((it) => !categories.some((c) => c.id === it.category_id));
    if (orphans.length) {
      html += `<div class="card glass"><strong style="font-size:1.15rem">Brez kategorije</strong>
        ${orphans.map((it, ii) => itemRow(it, ii, orphans.length)).join('')}</div>`;
    }
    host.innerHTML = html;
    wireRows();
  }

  function itemRow(it, idx, total) {
    return `
      <div class="list-card" style="margin:10px 0 0; background:var(--surface)">
        ${it.image_url ? `<img src="${esc(it.image_url)}" style="width:48px;height:48px;border-radius:8px;object-fit:cover" />`
          : '<div style="width:48px;height:48px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--surface-2)">🍽️</div>'}
        <div class="grow">
          <div class="title">${esc(it.name)} ${it.is_available ? '' : '<span class="badge badge-cancelled">Ni na voljo</span>'}</div>
          <div class="sub">${formatPrice(it.price, tenant.currency)}${it.description ? ' · ' + esc(it.description) : ''}</div>
        </div>
        <label class="switch" title="Na voljo">
          <input type="checkbox" data-avail="${it.id}" ${it.is_available ? 'checked' : ''}/>
          <span class="track"></span>
        </label>
        <button class="btn btn-sm btn-icon" data-item-up="${it.id}" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-sm btn-icon" data-item-down="${it.id}" ${idx === total - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-sm" data-item-edit="${it.id}">Uredi</button>
        <button class="btn btn-sm btn-danger" data-item-del="${it.id}">🗑</button>
      </div>`;
  }

  function wireRows() {
    const host = document.getElementById('page-content');
    host.querySelectorAll('[data-cat-edit]').forEach((b) => b.addEventListener('click', () => openCatModal(b.dataset.catEdit)));
    host.querySelectorAll('[data-cat-del]').forEach((b) => b.addEventListener('click', () => deleteCat(b.dataset.catDel)));
    host.querySelectorAll('[data-cat-up]').forEach((b) => b.addEventListener('click', () => moveCat(b.dataset.catUp, -1)));
    host.querySelectorAll('[data-cat-down]').forEach((b) => b.addEventListener('click', () => moveCat(b.dataset.catDown, 1)));
    host.querySelectorAll('[data-item-edit]').forEach((b) => b.addEventListener('click', () => openItemModal(b.dataset.itemEdit)));
    host.querySelectorAll('[data-item-del]').forEach((b) => b.addEventListener('click', () => deleteItem(b.dataset.itemDel)));
    host.querySelectorAll('[data-item-up]').forEach((b) => b.addEventListener('click', () => moveItem(b.dataset.itemUp, -1)));
    host.querySelectorAll('[data-item-down]').forEach((b) => b.addEventListener('click', () => moveItem(b.dataset.itemDown, 1)));
    host.querySelectorAll('[data-avail]').forEach((c) => c.addEventListener('change', () => toggleAvail(c.dataset.avail, c.checked)));
  }

  // --- Categories -----------------------------------------------------------
  function openCatModal(id) {
    editingCatId = id || null;
    const cat = id ? categories.find((c) => c.id === id) : null;
    document.getElementById('cat-modal-title').textContent = cat ? 'Uredi kategorijo' : 'Nova kategorija';
    document.getElementById('cat-name').value = cat?.name || '';
    document.getElementById('cat-icon').value = cat?.icon || '';
    document.getElementById('cat-sort').value = cat?.sort_order ?? categories.length;
    document.getElementById('cat-active').checked = cat ? cat.is_active : true;
    openModal('cat-modal');
  }

  async function saveCat() {
    const payload = {
      tenant_id: tenant.id,
      name: document.getElementById('cat-name').value.trim(),
      icon: document.getElementById('cat-icon').value.trim() || null,
      sort_order: Number(document.getElementById('cat-sort').value) || 0,
      is_active: document.getElementById('cat-active').checked,
    };
    if (!payload.name) return toast('Vnesite ime kategorije.', 'error');
    const q = editingCatId
      ? sb.from('categories').update(payload).eq('id', editingCatId)
      : sb.from('categories').insert(payload);
    const { error } = await q;
    if (error) { console.error(error); return toast('Napaka pri shranjevanju.', 'error'); }
    closeModal('cat-modal'); toast('Shranjeno.', 'success'); await load();
  }

  async function deleteCat(id) {
    if (!confirm('Izbrišem kategorijo? Izdelki bodo ostali brez kategorije.')) return;
    const { error } = await sb.from('categories').delete().eq('id', id);
    if (error) return toast('Napaka pri brisanju.', 'error');
    toast('Izbrisano.', 'success'); await load();
  }

  async function moveCat(id, dir) {
    const idx = categories.findIndex((c) => c.id === id);
    const other = categories[idx + dir];
    if (!other) return;
    const a = categories[idx];
    await Promise.all([
      sb.from('categories').update({ sort_order: other.sort_order }).eq('id', a.id),
      sb.from('categories').update({ sort_order: a.sort_order }).eq('id', other.id),
    ]);
    await load();
  }

  // --- Items ----------------------------------------------------------------
  function openItemModal(id) {
    editingItemId = id || null;
    const it = id ? items.find((x) => x.id === id) : null;
    document.getElementById('item-modal-title').textContent = it ? 'Uredi izdelek' : 'Nov izdelek';
    document.getElementById('item-name').value = it?.name || '';
    document.getElementById('item-desc').value = it?.description || '';
    document.getElementById('item-price').value = it?.price ?? '';
    document.getElementById('item-sort').value = it?.sort_order ?? 0;
    document.getElementById('item-allergens').value = it?.allergens || '';
    document.getElementById('item-vat').value = (it?.vat_rate ?? '') === null ? '' : (it?.vat_rate ?? '');
    document.getElementById('item-available').checked = it ? it.is_available : true;
    document.getElementById('item-image').value = '';
    document.getElementById('item-image-preview').textContent = it?.image_url ? 'Trenutna slika je nastavljena.' : '';
    const sel = document.getElementById('item-category');
    sel.innerHTML = '<option value="">— brez kategorije —</option>' +
      categories.map((c) => `<option value="${c.id}" ${it && it.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    openModal('item-modal');
  }

  async function uploadImage(file) {
    const ext = file.name.split('.').pop();
    const path = `${tenant.id}/${crypto.randomUUID()}.${ext}`;
    const { error } = await sb.storage.from('menu-images').upload(path, file, { upsert: true });
    if (error) throw error;
    const { data } = sb.storage.from('menu-images').getPublicUrl(path);
    return data.publicUrl;
  }

  async function saveItem() {
    const name = document.getElementById('item-name').value.trim();
    const price = Number(document.getElementById('item-price').value);
    if (!name) return toast('Vnesite ime izdelka.', 'error');
    if (isNaN(price)) return toast('Vnesite veljavno ceno.', 'error');

    const btn = document.getElementById('item-save');
    btn.disabled = true; btn.textContent = 'Shranjujem…';
    try {
      const payload = {
        tenant_id: tenant.id,
        name,
        description: document.getElementById('item-desc').value.trim() || null,
        price,
        sort_order: Number(document.getElementById('item-sort').value) || 0,
        category_id: document.getElementById('item-category').value || null,
        allergens: document.getElementById('item-allergens').value.trim() || null,
        vat_rate: document.getElementById('item-vat').value === '' ? null : Number(document.getElementById('item-vat').value),
        is_available: document.getElementById('item-available').checked,
      };
      const file = document.getElementById('item-image').files[0];
      if (file) payload.image_url = await uploadImage(file);

      const q = editingItemId
        ? sb.from('menu_items').update(payload).eq('id', editingItemId)
        : sb.from('menu_items').insert(payload);
      const { error } = await q;
      if (error) throw error;
      closeModal('item-modal'); toast('Shranjeno.', 'success'); await load();
    } catch (err) {
      console.error(err); toast('Napaka pri shranjevanju.', 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Shrani';
    }
  }

  async function deleteItem(id) {
    if (!confirm('Izbrišem izdelek?')) return;
    const { error } = await sb.from('menu_items').delete().eq('id', id);
    if (error) return toast('Napaka pri brisanju.', 'error');
    toast('Izbrisano.', 'success'); await load();
  }

  async function toggleAvail(id, val) {
    const { error } = await sb.from('menu_items').update({ is_available: val }).eq('id', id);
    if (error) return toast('Napaka.', 'error');
    const it = items.find((x) => x.id === id); if (it) it.is_available = val;
    toast(val ? 'Na voljo.' : 'Ni na voljo.', 'success');
  }

  async function moveItem(id, dir) {
    const it = items.find((x) => x.id === id);
    const siblings = items.filter((x) => x.category_id === it.category_id);
    const idx = siblings.findIndex((x) => x.id === id);
    const other = siblings[idx + dir];
    if (!other) return;
    await Promise.all([
      sb.from('menu_items').update({ sort_order: other.sort_order }).eq('id', it.id),
      sb.from('menu_items').update({ sort_order: it.sort_order }).eq('id', other.id),
    ]);
    await load();
  }

  // --- Modal helpers --------------------------------------------------------
  function openModal(id) { document.getElementById(id).classList.add('open'); }
  function closeModal(id) { document.getElementById(id).classList.remove('open'); }
  function wireModals() {
    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => closeModal(b.dataset.close)));
    document.querySelectorAll('.modal-backdrop').forEach((bd) =>
      bd.addEventListener('click', (e) => { if (e.target === bd) bd.classList.remove('open'); }));
    document.getElementById('cat-save').addEventListener('click', saveCat);
    document.getElementById('item-save').addEventListener('click', saveItem);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
