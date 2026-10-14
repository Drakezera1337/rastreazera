// FB Radar Coletor — confere a categoria "Consoles de Video Game" do Facebook Marketplace.
//
// Ligado pelo botão "Iniciar" do painel da extensão: confere na hora e depois a cada N minutos.
// Cada conferência baixa a página da categoria (ordenada pelos mais novos) com a sessão do Facebook
// deste Chrome e lê os dados que a própria página traz (id, título, preço, cidade, foto, data de
// criação) — sem abrir aba. Se a página vier sem os dados, abre uma aba em segundo plano, lê e fecha.
// Envia tudo ao server.py, que guarda, filtra pelas cidades e avisa o celular dos anúncios novos.
// Só lê — nunca clica em nada no Facebook.

const RZ = 'http://localhost:5500';
const URL_CATEGORIA = 'https://www.facebook.com/marketplace/category/consoles-de-video-game/?sortBy=creation_time_descend&exact=false';
const INTERVALO_PADRAO_MIN = 3;

async function estado() {
  const d = await chrome.storage.local.get(['ativo', 'intervalo', 'ultima', 'emAndamento']);
  return {
    ativo: Boolean(d.ativo),
    intervalo: d.intervalo || INTERVALO_PADRAO_MIN,
    ultima: d.ultima || null, // { em, n, erro, metodo }
    emAndamento: d.emAndamento || 0,
  };
}

async function agendar() {
  const { ativo, intervalo } = await estado();
  if (ativo) await chrome.alarms.create('coleta', { periodInMinutes: intervalo });
  else await chrome.alarms.clear('coleta');
  await reportarAgenda();
}

async function reportarAgenda() {
  const { ativo, intervalo } = await estado();
  const alarme = await chrome.alarms.get('coleta');
  await api('/api/fb/agenda', { ativo, intervalo, proxima: ativo ? alarme?.scheduledTime || null : null }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(agendar);
chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.remove('emAndamento');
  await agendar();
  if ((await estado()).ativo) coletar();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'coleta' && (await estado()).ativo) coletar();
});

// ---------- Painel (popup.html) ----------
chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  (async () => {
    if (msg.tipo === 'iniciar') {
      await chrome.storage.local.set({ ativo: true });
      await agendar();
      coletar();
    } else if (msg.tipo === 'parar') {
      await chrome.storage.local.set({ ativo: false });
      await agendar();
    } else if (msg.tipo === 'agora') {
      coletar();
    } else if (msg.tipo === 'intervalo') {
      const min = Math.min(30, Math.max(1, Number(msg.valor) || INTERVALO_PADRAO_MIN));
      await chrome.storage.local.set({ intervalo: min });
      await agendar();
    }
    const est = await estado();
    const alarme = await chrome.alarms.get('coleta');
    responder({ ...est, proxima: est.ativo ? alarme?.scheduledTime || null : null });
  })();
  return true;
});

// ---------- Coleta ----------
async function coletar() {
  const { emAndamento } = await estado();
  if (emAndamento && Date.now() - emAndamento < 2 * 60000) return; // uma de cada vez
  await chrome.storage.local.set({ emAndamento: Date.now() });

  let anuncios = [];
  let metodo = 'página';
  let erro = '';
  try {
    anuncios = await coletarPorRequisicao();
    if (!anuncios.length) {
      metodo = 'aba';
      anuncios = await coletarPorAba();
    }
    if (!anuncios.length) erro = 'a página da categoria veio sem anúncios (o Facebook mudou o layout?)';
  } catch (e) {
    erro = e.message || String(e);
  }

  const ultima = { em: Date.now(), n: anuncios.length, erro, metodo };
  await chrome.storage.local.set({ ultima, emAndamento: 0 });
  await api('/api/fb/coleta', { anuncios, erro, metodo }).catch((e) => {
    chrome.storage.local.set({ ultima: { ...ultima, erro: `server.py não respondeu (${e.message})` } });
  });
  await reportarAgenda();
}

async function coletarPorRequisicao() {
  const res = await fetch(URL_CATEGORIA, { credentials: 'include', headers: { Accept: 'text/html' }, cache: 'no-store' });
  if (/\/login|\/checkpoint\//.test(res.url)) throw new Error('Facebook deslogado neste Chrome — entre em facebook.com');
  if (!res.ok) throw new Error(`Facebook respondeu ${res.status}`);
  const html = await res.text();
  const blocos = [];
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    if (m[1].includes('marketplace_listing_title')) blocos.push(m[1]);
  }
  return extrair(blocos);
}

// Reserva: abre a página numa aba em segundo plano e lê os mesmos blocos de dados
async function coletarPorAba() {
  const aba = await chrome.tabs.create({ url: URL_CATEGORIA, active: false });
  try {
    await esperarCarregar(aba.id, 45000);
    await new Promise((r) => setTimeout(r, 3000));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: aba.id },
      func: () => ({
        url: location.href,
        blocos: [...document.querySelectorAll('script[type="application/json"]')]
          .map((s) => s.textContent).filter((t) => t.includes('marketplace_listing_title')),
      }),
    });
    if (/\/login|\/checkpoint\//.test(result.url)) throw new Error('Facebook deslogado neste Chrome — entre em facebook.com');
    return extrair(result.blocos);
  } finally {
    chrome.tabs.remove(aba.id).catch(() => {});
  }
}

function esperarCarregar(tabId, limite) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(ouvir); reject(new Error('a página do Facebook não carregou')); }, limite);
    function ouvir(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(ouvir);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(ouvir);
  });
}

// Percorre o JSON da página atrás dos anúncios (objetos com marketplace_listing_title)
function extrair(blocos) {
  const vistos = new Map();
  const visitar = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(visitar); return; }
    if (typeof o.marketplace_listing_title === 'string' && /^\d+$/.test(String(o.id)) && !vistos.has(o.id)) {
      const geo = o.location?.reverse_geocode || {};
      vistos.set(o.id, {
        id: String(o.id),
        titulo: o.marketplace_listing_title.replace(/\s+/g, ' ').trim().slice(0, 140),
        preco: Number(o.listing_price?.amount) || 0,
        precoTexto: o.listing_price?.formatted_amount || '',
        cidade: geo.city || '',
        uf: geo.state || '',
        foto: o.primary_listing_photo?.image?.uri || '',
        criadoEm: o.creation_time ? o.creation_time * 1000 : null,
        vendedor: o.marketplace_listing_seller?.name || '',
        vendido: Boolean(o.is_sold),
        reservado: Boolean(o.is_pending),
      });
    }
    for (const k in o) visitar(o[k]);
  };
  for (const b of blocos) {
    try { visitar(JSON.parse(b)); } catch { /* bloco que não é JSON completo */ }
  }
  return [...vistos.values()];
}

async function api(caminho, corpo) {
  const res = await fetch(RZ + caminho, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  if (!res.ok) throw new Error(`erro ${res.status}`);
  return res.json();
}
