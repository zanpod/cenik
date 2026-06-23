// ============================================================================
// EPO.SI — Service worker (offline shell + asset caching)
// Strategy: same-origin GET only. Navigations = network-first (fresh, with
// offline fallback). Static assets = cache-first. Cross-origin (Supabase API,
// CDN) is never intercepted — data always goes to the network.
// ============================================================================
const CACHE = 'epo-v4';
const ASSETS = [
  '/', '/index.html',
  '/css/common.css', '/css/menu.css', '/css/admin.css',
  '/js/supabase-config.js', '/js/common.js', '/js/cart.js', '/js/menu.js',
  '/js/admin-auth.js', '/js/dashboard.js', '/js/menu-manage.js', '/js/tables.js',
  '/js/orders-history.js', '/js/settings.js', '/js/new-order.js',
  '/js/inventory.js', '/js/invoice.js',
  '/assets/logo.svg', '/assets/notification.wav',
  '/assets/icon-192.png', '/assets/icon-512.png',
  '/menu/index.html',
  '/admin/index.html', '/admin/dashboard.html', '/admin/new-order.html',
  '/admin/menu.html', '/admin/inventory.html', '/admin/tables.html',
  '/admin/orders.html', '/admin/settings.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(ASSETS.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network-first za vse iste-izvorne GET zahteve: ko si na spletu, dobiš vedno
// svežo kodo; predpomnilnik se uporabi le, ko ni povezave. Tako posodobitve
// takoj zaživijo (brez "obtičale" stare JS/CSS).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Supabase / CDN → network

  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((m) => m || (req.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});
