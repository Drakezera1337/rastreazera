// Cache simples para o app abrir rápido e funcionar offline (os dados ficam no localStorage).
const CACHE = 'rastreazera-v16';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'config.js', 'carriers.js', 'sync.js', 'trackers.js', 'coletor/coletores.js', 'icon.svg', 'manifest.webmanifest'];

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
      .catch(() => caches.match(e.request))
  );
});
