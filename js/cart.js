// ============================================================================
// EPO.SI — Cart management (persisted in localStorage per table)
// ============================================================================

const Cart = (() => {
  let storageKey = 'epo_cart';
  let items = {}; // menu_item_id -> { id, name, price, quantity, note }
  const listeners = [];

  function setScope(tenantSlug, tableToken) {
    storageKey = `epo_cart_${tenantSlug}_${tableToken}`;
    load();
  }

  function load() {
    try {
      const raw = localStorage.getItem(storageKey);
      items = raw ? JSON.parse(raw) : {};
    } catch { items = {}; }
    emit();
  }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(items)); } catch {}
  }

  function emit() {
    const snapshot = getState();
    listeners.forEach((fn) => fn(snapshot));
  }

  function onChange(fn) { listeners.push(fn); fn(getState()); }

  function add(menuItem) {
    const id = menuItem.id;
    if (items[id]) {
      items[id].quantity += 1;
    } else {
      items[id] = {
        id,
        menu_item_id: menuItem.menu_item_id || menuItem.id,
        name: menuItem.name,
        price: Number(menuItem.price),
        quantity: 1,
        note: '',
      };
    }
    persist(); emit();
  }

  function remove(id) {
    if (!items[id]) return;
    items[id].quantity -= 1;
    if (items[id].quantity <= 0) delete items[id];
    persist(); emit();
  }

  function removeAll(id) { delete items[id]; persist(); emit(); }

  function setNote(id, note) {
    if (items[id]) { items[id].note = note; persist(); }
  }

  function quantityOf(id) { return items[id] ? items[id].quantity : 0; }

  function clear() { items = {}; persist(); emit(); }

  function getState() {
    const list = Object.values(items);
    const count = list.reduce((s, i) => s + i.quantity, 0);
    const total = list.reduce((s, i) => s + i.quantity * i.price, 0);
    return { items: list, count, total };
  }

  return {
    setScope, onChange, add, remove, removeAll, setNote,
    quantityOf, clear, getState,
  };
})();

window.Cart = Cart;
