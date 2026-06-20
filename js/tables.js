// ============================================================================
// EPO.SI — Table & QR code management
// QR encodes: {APP_DOMAIN}/menu/{slug}?table={qr_code_token}
// ============================================================================

(function () {
  let tenant = null;
  let tables = [];
  let editingId = null;

  async function init() {
    const ctx = await AdminShell.init('tables', 'Upravljanje miz');
    if (!ctx) return;
    tenant = ctx.tenant;
    document.getElementById('header-actions').innerHTML = `
      <button class="btn btn-sm no-print" id="print-all">🖨 Natisni vse QR kode</button>
      <button class="btn btn-primary btn-sm no-print" id="add-table">＋ Dodaj mizo</button>`;
    document.getElementById('add-table').addEventListener('click', () => openModal());
    document.getElementById('print-all').addEventListener('click', () => window.print());
    wireModal();
    await load();
  }

  function menuUrl(t) {
    return `${window.APP_DOMAIN}/menu/${tenant.slug}?table=${t.qr_code_token}`;
  }

  async function load() {
    const { data, error } = await sb.from('tables').select('*')
      .eq('tenant_id', tenant.id).order('table_number');
    if (error) { console.error(error); return; }
    tables = data || [];
    render();
  }

  function render() {
    const host = document.getElementById('page-content');
    if (!tables.length) {
      host.innerHTML = '<div class="empty-state"><div class="emoji">🪑</div><p>Dodajte prvo mizo.</p></div>';
      return;
    }
    host.innerHTML = `<div class="qr-grid">${tables.map(qrCard).join('')}</div>`;
    tables.forEach(renderQr);
    wireCards();
  }

  function qrCard(t) {
    const label = t.label || `Miza ${t.table_number}`;
    return `
      <div class="qr-card glass">
        <div class="qr-canvas" id="qr-${t.id}"></div>
        <div class="qr-title">${esc(label)}</div>
        <div class="qr-sub">${esc(menuUrl(t))}</div>
        ${t.is_active ? '' : '<span class="badge badge-cancelled" style="margin-bottom:8px">Neaktivna</span>'}
        <div class="qr-actions no-print">
          <button class="btn btn-sm" data-dl="${t.id}">⬇ Prenesi</button>
          <button class="btn btn-sm" data-edit="${t.id}">Uredi</button>
          <button class="btn btn-sm btn-danger" data-del="${t.id}">🗑</button>
        </div>
      </div>`;
  }

  function renderQr(t) {
    const el = document.getElementById(`qr-${t.id}`);
    if (!el) return;
    el.innerHTML = '';
    // qrcodejs renders into the element (canvas + img). Level H for reliability.
    new QRCode(el, {
      text: menuUrl(t),
      width: 220,
      height: 220,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H,
    });
  }

  function wireCards() {
    const host = document.getElementById('page-content');
    host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openModal(b.dataset.edit)));
    host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => del(b.dataset.del)));
    host.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => download(b.dataset.dl)));
  }

  // Download QR as a high-resolution PNG with the table label beneath it.
  function download(id) {
    const t = tables.find((x) => x.id === id);
    const src = document.querySelector(`#qr-${id} canvas`) || document.querySelector(`#qr-${id} img`);
    if (!src) return;
    const label = t.label || `Miza ${t.table_number}`;
    const SIZE = 900;          // high-res print quality
    const pad = 60;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE + pad * 2;
    canvas.height = SIZE + pad * 2 + 90;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const drawAll = (img) => {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, pad, pad, SIZE, SIZE);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 54px -apple-system, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, canvas.width / 2, SIZE + pad + 70);
      const a = document.createElement('a');
      a.download = `qr-${tenant.slug}-miza-${t.table_number}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    };

    if (src.tagName === 'CANVAS') {
      const img = new Image();
      img.onload = () => drawAll(img);
      img.src = src.toDataURL('image/png');
    } else {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => drawAll(img);
      img.src = src.src;
    }
  }

  function openModal(id) {
    editingId = id || null;
    const t = id ? tables.find((x) => x.id === id) : null;
    document.getElementById('table-modal-title').textContent = t ? 'Uredi mizo' : 'Nova miza';
    document.getElementById('table-number').value = t?.table_number ?? (maxNumber() + 1);
    document.getElementById('table-label').value = t?.label || '';
    document.getElementById('table-active').checked = t ? t.is_active : true;
    document.getElementById('table-modal').classList.add('open');
  }

  function maxNumber() {
    return tables.reduce((m, t) => Math.max(m, t.table_number), 0);
  }

  async function save() {
    const num = parseInt(document.getElementById('table-number').value, 10);
    if (isNaN(num)) return toast('Vnesite številko mize.', 'error');
    const payload = {
      tenant_id: tenant.id,
      table_number: num,
      label: document.getElementById('table-label').value.trim() || null,
      is_active: document.getElementById('table-active').checked,
    };
    const q = editingId
      ? sb.from('tables').update(payload).eq('id', editingId)
      : sb.from('tables').insert(payload);
    const { error } = await q;
    if (error) {
      console.error(error);
      return toast(error.code === '23505' ? 'Miza s to številko že obstaja.' : 'Napaka pri shranjevanju.', 'error');
    }
    document.getElementById('table-modal').classList.remove('open');
    toast('Shranjeno.', 'success'); await load();
  }

  async function del(id) {
    if (!confirm('Izbrišem mizo? QR koda ne bo več delovala.')) return;
    const { error } = await sb.from('tables').delete().eq('id', id);
    if (error) return toast('Napaka pri brisanju.', 'error');
    toast('Izbrisano.', 'success'); await load();
  }

  function wireModal() {
    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => document.getElementById(b.dataset.close).classList.remove('open')));
    document.getElementById('table-modal').addEventListener('click', (e) => {
      if (e.target.id === 'table-modal') e.target.classList.remove('open');
    });
    document.getElementById('table-save').addEventListener('click', save);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
