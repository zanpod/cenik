// ============================================================================
// EPO.SI — Shared helpers (toasts, formatting, branding, time)
// ============================================================================

// --- PWA: manifest link + service worker registration -----------------------
(function registerPwa() {
  try {
    if (!document.querySelector('link[rel="manifest"]')) {
      const l = document.createElement('link');
      l.rel = 'manifest';
      l.href = '/manifest.webmanifest';
      document.head.appendChild(l);
    }
    if (!document.querySelector('link[rel="apple-touch-icon"]')) {
      const a = document.createElement('link');
      a.rel = 'apple-touch-icon';
      a.href = '/assets/icon-192.png';
      document.head.appendChild(a);
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
    }
  } catch {}
})();

// --- Toast notifications ----------------------------------------------------
function toast(message, type = '', timeout = 3200) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ` toast-${type}` : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity .25s, transform .25s';
    setTimeout(() => el.remove(), 280);
  }, timeout);
}

// --- Currency formatting ----------------------------------------------------
function formatPrice(amount, currency = '€') {
  const n = Number(amount || 0);
  return `${n.toFixed(2).replace('.', ',')} ${currency}`;
}

// --- Relative time in Slovenian ("pred 3 min") ------------------------------
function timeAgo(dateStr) {
  const then = new Date(dateStr).getTime();
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'pravkar';
  if (min === 1) return 'pred 1 min';
  if (min < 60) return `pred ${min} min`;
  const h = Math.floor(min / 60);
  if (h === 1) return 'pred 1 uro';
  if (h < 5) return `pred ${h} urami`;
  if (h < 24) return `pred ${h} urami`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'pred 1 dnem' : `pred ${d} dnevi`;
}

// --- Local time in Europe/Ljubljana -----------------------------------------
function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('sl-SI', {
    timeZone: 'Europe/Ljubljana',
    hour: '2-digit',
    minute: '2-digit',
  });
}
function formatDateTime(dateStr) {
  return new Date(dateStr).toLocaleString('sl-SI', {
    timeZone: 'Europe/Ljubljana',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// --- Apply tenant brand colors to CSS custom properties ---------------------
function applyBranding(tenant) {
  if (!tenant) return;
  const root = document.documentElement;
  if (tenant.primary_color) root.style.setProperty('--brand-primary', tenant.primary_color);
  if (tenant.secondary_color) root.style.setProperty('--brand-secondary', tenant.secondary_color);
}

// --- Escape HTML ------------------------------------------------------------
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- Status labels (Slovenian) ----------------------------------------------
const STATUS_LABELS = {
  new: '🟢 Novo',
  preparing: '🟡 V pripravi',
  served: '✅ Postreženo',
  cancelled: '❌ Preklicano',
};

window.toast = toast;
window.formatPrice = formatPrice;
window.timeAgo = timeAgo;
window.formatTime = formatTime;
window.formatDateTime = formatDateTime;
window.applyBranding = applyBranding;
window.esc = esc;
window.STATUS_LABELS = STATUS_LABELS;
