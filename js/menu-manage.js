// ============================================================================
// EPO.SI — Menu management (categories + items CRUD, image upload, reorder)
// ============================================================================

(function () {
  let tenant = null;
  let categories = [];
  let items = [];
  let ingredients = [];
  let recipeRows = [];   // [{ ingredient_id, quantity }] za odprt item modal
  let variantRows = [];  // [{ name, price }] za odprt item modal
  let editingCatId = null;
  let editingItemId = null;

  // Sestavine se v recepturi vnašajo v OSNOVNI enoti (g / ml / kos, enako kot
  // stock_quantity — glej migracijo 004), nabavna cena pa je shranjena na
  // NABAVNO enoto (kg / L / kos, glej js/inventory.js). Pretvorba mora biti
  // ista na obeh mestih, da se "nabavna cena sestavin" ujema z zalogo.
  const unitFactor = (b) => (b === 'ml' || b === 'g' ? 1000 : 1);
  const toPurchaseQty = (baseQty, b) => Number(baseQty) / unitFactor(b);

  async function init() {
    const ctx = await AdminShell.init('menu', 'Upravljanje menija');
    if (!ctx) return;
    tenant = ctx.tenant;
    document.getElementById('header-actions').innerHTML = `
      <button class="btn btn-sm" id="open-ingredients">📦 Surovine</button>
      <button class="btn btn-sm" id="add-cat">＋ Kategorija</button>
      <button class="btn btn-primary btn-sm" id="add-item">＋ Izdelek</button>`;
    document.getElementById('open-ingredients').addEventListener('click', openIngredients);
    document.getElementById('add-cat').addEventListener('click', () => openCatModal());
    document.getElementById('add-item').addEventListener('click', () => openItemModal());
    document.getElementById('ing-add').addEventListener('click', addIngredient);
    document.getElementById('item-add-ingredient').addEventListener('click', () => { recipeRows.push({ ingredient_id: '', quantity: 0 }); renderRecipeRows(); });
    document.getElementById('item-add-variant').addEventListener('click', () => { variantRows.push({ name: '', price: 0 }); renderVariantRows(); });
    document.getElementById('item-margin').addEventListener('input', recalcItemCost);
    document.getElementById('item-use-suggested').addEventListener('click', () => {
      const v = document.getElementById('item-suggested-price').value;
      if (v) document.getElementById('item-price').value = v;
    });
    wireModals();
    await load();
  }

  async function load() {
    const [c, i, ing] = await Promise.all([
      sb.from('categories').select('*').eq('tenant_id', tenant.id).order('sort_order'),
      sb.from('menu_items').select('*').eq('tenant_id', tenant.id).order('sort_order'),
      sb.from('ingredients').select('*').eq('tenant_id', tenant.id).order('name'),
    ]);
    categories = c.data || [];
    items = i.data || [];
    ingredients = ing.data || [];
    render();
  }

  // --- Surovine (ingredients) -----------------------------------------------
  function openIngredients() { renderIngredients(); openModal('ing-modal'); }

  function renderIngredients() {
    const host = document.getElementById('ing-list');
    if (!ingredients.length) { host.innerHTML = '<p class="muted">Ni surovin. Dodajte spodaj.</p>'; return; }
    host.innerHTML = ingredients.map((g) => `
      <div class="list-card" style="background:var(--surface)">
        <div class="grow">
          <div class="title">${esc(g.name)}</div>
          <div class="sub">Zaloga: <strong>${(+g.stock_quantity).toLocaleString('sl-SI')}</strong> ${esc(g.unit)}</div>
        </div>
        <button class="btn btn-sm" data-ing-receive="${g.id}">📥 Prevzem</button>
        <button class="btn btn-sm btn-danger" data-ing-del="${g.id}">🗑</button>
      </div>`).join('');
    host.querySelectorAll('[data-ing-receive]').forEach((b) => b.addEventListener('click', () => receiveIngredient(b.dataset.ingReceive)));
    host.querySelectorAll('[data-ing-del]').forEach((b) => b.addEventListener('click', () => deleteIngredient(b.dataset.ingDel)));
  }

  async function addIngredient() {
    const name = document.getElementById('ing-name').value.trim();
    const unit = document.getElementById('ing-unit').value;
    const stock = Number(document.getElementById('ing-stock').value) || 0;
    if (!name) return toast('Vnesite naziv surovine.', 'error');
    const { error } = await sb.from('ingredients').insert({ tenant_id: tenant.id, name, unit, stock_quantity: stock });
    if (error) { console.error(error); return toast('Napaka pri dodajanju.', 'error'); }
    document.getElementById('ing-name').value = '';
    document.getElementById('ing-stock').value = '0';
    await reloadIngredients(); renderIngredients(); toast('Surovina dodana.', 'success');
  }

  async function receiveIngredient(id) {
    const g = ingredients.find((x) => x.id === id);
    const v = prompt(`Prevzem surovine "${g.name}" (${g.unit}). Vnesite količino za dodajanje (negativno za odpis):`, '0');
    if (v === null) return;
    const delta = Number(v);
    if (isNaN(delta) || delta === 0) return;
    const { error } = await sb.rpc('receive_ingredient', { p_ingredient_id: id, p_delta: delta, p_reason: 'intake', p_note: null });
    if (error) { console.error(error); return toast('Napaka pri prevzemu.', 'error'); }
    await reloadIngredients(); renderIngredients(); toast('Zaloga posodobljena.', 'success');
  }

  async function deleteIngredient(id) {
    if (!confirm('Izbrišem surovino? Odstrani se tudi iz vseh receptur.')) return;
    const { error } = await sb.from('ingredients').delete().eq('id', id);
    if (error) return toast('Napaka pri brisanju.', 'error');
    await reloadIngredients(); renderIngredients(); toast('Izbrisano.', 'success');
  }

  async function reloadIngredients() {
    const { data } = await sb.from('ingredients').select('*').eq('tenant_id', tenant.id).order('name');
    ingredients = data || [];
  }

  function renderVariantRows() {
    const host = document.getElementById('item-variant-rows');
    if (!variantRows.length) { host.innerHTML = '<p class="muted" style="font-size:.82rem;margin:0">Brez variant.</p>'; return; }
    host.innerHTML = variantRows.map((v, idx) => `
      <div class="row" style="margin-bottom:6px">
        <input class="input var-name" data-idx="${idx}" placeholder="npr. Velika" value="${esc(v.name)}" style="flex:1" />
        <input class="input var-price" data-idx="${idx}" type="number" step="0.01" placeholder="cena" value="${v.price}" style="width:110px" />
        <button class="btn btn-sm btn-danger var-del" data-idx="${idx}" type="button">🗑</button>
      </div>`).join('');
    host.querySelectorAll('.var-name').forEach((s) => s.addEventListener('input', (e) => { variantRows[+e.target.dataset.idx].name = e.target.value; }));
    host.querySelectorAll('.var-price').forEach((s) => s.addEventListener('input', (e) => { variantRows[+e.target.dataset.idx].price = Number(e.target.value) || 0; }));
    host.querySelectorAll('.var-del').forEach((b) => b.addEventListener('click', (e) => { variantRows.splice(+e.target.dataset.idx, 1); renderVariantRows(); }));
  }

  // --- Receptura v item modalu ----------------------------------------------
  function renderRecipeRows() {
    const host = document.getElementById('item-recipe-rows');
    if (!recipeRows.length) { host.innerHTML = '<p class="muted" style="font-size:.82rem;margin:0">Ni sestavin.</p>'; }
    else {
      host.innerHTML = recipeRows.map((r, idx) => `
        <div class="row" style="margin-bottom:6px">
          <select class="select recipe-ing" data-idx="${idx}" style="flex:1">
            <option value="">— izberi surovino —</option>
            ${ingredients.map((g) => `<option value="${g.id}" ${g.id === r.ingredient_id ? 'selected' : ''}>${esc(g.name)} (${esc(g.unit)})</option>`).join('')}
          </select>
          <input class="input recipe-qty" data-idx="${idx}" type="number" step="0.001" value="${r.quantity}" style="width:110px" placeholder="količina" />
          <button class="btn btn-sm btn-danger recipe-del" data-idx="${idx}" type="button">🗑</button>
        </div>`).join('');
      host.querySelectorAll('.recipe-ing').forEach((s) => s.addEventListener('change', (e) => {
        recipeRows[+e.target.dataset.idx].ingredient_id = e.target.value; recalcItemCost();
      }));
      host.querySelectorAll('.recipe-qty').forEach((s) => s.addEventListener('input', (e) => {
        recipeRows[+e.target.dataset.idx].quantity = Number(e.target.value) || 0; recalcItemCost();
      }));
      host.querySelectorAll('.recipe-del').forEach((b) => b.addEventListener('click', (e) => {
        recipeRows.splice(+e.target.dataset.idx, 1); renderRecipeRows();
      }));
    }
    recalcItemCost();
  }

  // Nabavna cena sestavin za 1 kos izdelka + priporočena prodajna cena, da
  // sestavine predstavljajo željen delež (marža) končne cene. Samo predlog —
  // "Uporabi" prepiše polje s ceno, ki ostane ročno urejljivo.
  function recalcItemCost() {
    const costEl = document.getElementById('item-cost-value');
    const suggEl = document.getElementById('item-suggested-price');
    if (!costEl || !suggEl) return;

    const cost = recipeRows.reduce((sum, r) => {
      const ing = ingredients.find((g) => g.id === r.ingredient_id);
      if (!ing || !r.quantity) return sum;
      return sum + toPurchaseQty(r.quantity, ing.unit) * Number(ing.purchase_price || 0);
    }, 0);

    const currency = (tenant && tenant.currency) || '€';
    costEl.textContent = formatPrice(cost, currency);

    const margin = Math.min(95, Math.max(0, Number(document.getElementById('item-margin').value) || 0));
    const suggested = cost > 0 ? cost / (1 - margin / 100) : 0;
    suggEl.value = suggested > 0 ? suggested.toFixed(2) : '';
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

  function stockTag(it) {
    if (!it.track_stock) return '';
    const low = it.stock_quantity <= 0;
    return ` <span class="badge ${low ? 'badge-cancelled' : 'badge-served'}">Zaloga: ${it.stock_quantity}</span>`;
  }

  function itemRow(it, idx, total) {
    return `
      <div class="list-card" style="margin:10px 0 0; background:var(--surface)">
        ${it.image_url ? `<img src="${esc(it.image_url)}" style="width:48px;height:48px;border-radius:8px;object-fit:cover" />`
          : '<div style="width:48px;height:48px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--surface-2)">🍽️</div>'}
        <div class="grow">
          <div class="title">${esc(it.name)} ${it.is_available ? '' : '<span class="badge badge-cancelled">Ni na voljo</span>'}${stockTag(it)}</div>
          <div class="sub">${formatPrice(it.price, tenant.currency)}${it.description ? ' · ' + esc(it.description) : ''}</div>
        </div>
        ${it.track_stock ? `<button class="btn btn-sm" data-restock="${it.id}" title="Dopolni zalogo">📦 +</button>` : ''}
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
    host.querySelectorAll('[data-restock]').forEach((b) => b.addEventListener('click', () => restock(b.dataset.restock)));
  }

  async function restock(id) {
    const it = items.find((x) => x.id === id);
    const add = prompt(`Dodaj zalogo za "${it.name}" (trenutno: ${it.stock_quantity}). Vnesite število kosov za dodajanje (negativno za odvzem):`, '10');
    if (add === null) return;
    const delta = parseInt(add, 10);
    if (isNaN(delta)) return toast('Neveljavno število.', 'error');
    const next = (it.stock_quantity || 0) + delta;
    const { error } = await sb.from('menu_items').update({ stock_quantity: next }).eq('id', id);
    if (error) return toast('Napaka pri posodobitvi zaloge.', 'error');
    it.stock_quantity = next;
    toast(`Nova zaloga: ${next}`, 'success');
    render();
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
    document.getElementById('item-margin').value = 70;
    document.getElementById('item-sort').value = it?.sort_order ?? 0;
    document.getElementById('item-allergens').value = it?.allergens || '';
    document.getElementById('item-vat').value = (it?.vat_rate ?? '') === null ? '' : (it?.vat_rate ?? '');
    document.getElementById('item-available').checked = it ? it.is_available : true;
    document.getElementById('item-image').value = '';
    document.getElementById('item-image-preview').textContent = it?.image_url ? 'Trenutna slika je nastavljena.' : '';
    const trackEl = document.getElementById('item-track-stock');
    const stockField = document.getElementById('item-stock-field');
    trackEl.checked = !!it?.track_stock;
    document.getElementById('item-stock').value = it?.stock_quantity ?? 0;
    stockField.style.display = trackEl.checked ? '' : 'none';
    trackEl.onchange = () => { stockField.style.display = trackEl.checked ? '' : 'none'; };
    const sel = document.getElementById('item-category');
    sel.innerHTML = '<option value="">— brez kategorije —</option>' +
      categories.map((c) => `<option value="${c.id}" ${it && it.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

    document.getElementById('item-station').value = it?.prep_station || 'sank';
    variantRows = Array.isArray(it?.variants) ? it.variants.map((v) => ({ name: v.name, price: Number(v.price) })) : [];
    renderVariantRows();

    // Receptura: naloži obstoječe sestavine izdelka.
    recipeRows = [];
    renderRecipeRows();
    if (id) {
      sb.from('item_ingredients').select('ingredient_id, quantity').eq('menu_item_id', id).then(({ data }) => {
        recipeRows = (data || []).map((r) => ({ ingredient_id: r.ingredient_id, quantity: Number(r.quantity) }));
        renderRecipeRows();
      });
    }
    openModal('item-modal');
  }

  // Sinhronizira recepturo (item_ingredients) z vrsticami v modalu.
  async function syncRecipe(itemId) {
    await sb.from('item_ingredients').delete().eq('menu_item_id', itemId);
    const rows = recipeRows
      .filter((r) => r.ingredient_id && r.quantity > 0)
      .map((r) => ({ tenant_id: tenant.id, menu_item_id: itemId, ingredient_id: r.ingredient_id, quantity: r.quantity }));
    if (rows.length) {
      const { error } = await sb.from('item_ingredients').insert(rows);
      if (error) console.error(error);
    }
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
        track_stock: document.getElementById('item-track-stock').checked,
        stock_quantity: Number(document.getElementById('item-stock').value) || 0,
        prep_station: document.getElementById('item-station').value,
        variants: variantRows.filter((v) => v.name && v.price >= 0).map((v) => ({ name: v.name, price: Number(v.price) })),
      };
      const file = document.getElementById('item-image').files[0];
      if (file) payload.image_url = await uploadImage(file);

      const q = editingItemId
        ? sb.from('menu_items').update(payload).eq('id', editingItemId).select().single()
        : sb.from('menu_items').insert(payload).select().single();
      const { data: saved, error } = await q;
      if (error) throw error;
      await syncRecipe(saved.id);
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
