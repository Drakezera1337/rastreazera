// Cache simples para o app abrir rápido e funcionar offline (os dados ficam no localStorage).
const CACHE = 'rastreazera-v25';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'carriers.js', 'sync.js', 'trackers.js', 'coletor/coletores.js',
  'icon.svg', 'icon-192.png', 'badge-96.png', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  // cache: 'reload' baixa do servidor (sem reaproveitar o cache do navegador, que pode estar velho)
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Rede primeiro (para pegar atualizações), cache como reserva offline
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // "no-cache": sempre confere com o servidor se há versão nova (o GitHub Pages deixa o
  // navegador guardar os arquivos por 10 min — sem isso, uma atualização demoraria a chegar)
  const atualizado = e.request.mode === 'navigate'
    ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : fetch(e.request, { cache: 'no-cache' });
  e.respondWith(
    atualizado
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      // Offline: ignora o ?v= (o cache da instalação guarda os arquivos sem ele)
      .catch(() => caches.match(e.request).then((r) => r || caches.match(e.request, { ignoreSearch: true })))
  );
});

// ---------- Notificações ----------
// Push enviado pelo server.py do PC ao fim de uma busca com novidades: { title, body, tag }
self.addEventListener('push', (e) => {
  let dados = {};
  try { dados = e.data ? e.data.json() : {}; } catch { dados = { body: e.data && e.data.text() }; }
  e.waitUntil(mostrarNotificacao(dados));
});

// O app (aberto em segundo plano) também pede notificações: mudança de status detectada na hora
self.addEventListener('message', (e) => {
  if (e.data && e.data.tipo === 'notificar') e.waitUntil(mostrarNotificacao(e.data));
});

function mostrarNotificacao({ title, body, tag }) {
  return self.registration.showNotification(title || 'Rastreazera', {
    body: body || 'Há novidades nos seus rastreios.',
    tag: tag || 'rastreazera',
    renotify: true,
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    data: { url: self.registration.scope },
  });
}

// Tocar na notificação abre o app (ou traz para frente se já estiver aberto)
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const abertos = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = abertos.find((c) => c.url.startsWith(self.registration.scope));
    if (app) return app.focus();
    return self.clients.openWindow(self.registration.scope);
  })());
});
