// FB Radar: cache para abrir rápido/offline e notificações de anúncios novos (enviadas pelo server.py do PC).
const CACHE = 'fbradar-v31';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', '../config.js', '../sync.js',
  'icon.svg', 'icon-192.png', 'badge-96.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('fbradar-') && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Rede primeiro (pega atualizações), cache como reserva offline. A API do server.py nunca vai para o cache.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const atualizado = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    atualizado
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match(e.request, { ignoreSearch: true })))
  );
});

// Push: { title, body, tag, url?, image? } — url leva direto ao anúncio no Facebook
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'FB Radar', {
    body: d.body || 'Anúncio novo no Marketplace.',
    tag: d.tag || 'fbradar',
    renotify: true,
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    image: d.image || undefined,
    data: { url: d.url || self.registration.scope },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    if (destino.startsWith(self.registration.scope)) {
      const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const app = abertos.find((c) => c.url.startsWith(self.registration.scope));
      if (app) return app.focus();
    }
    return self.clients.openWindow(destino);
  })());
});
