// FB Radar Coletor — confere a categoria "Consoles de Video Game" do Facebook Marketplace.
//
// Ligado pelo botão "Iniciar" do painel da extensão: confere na hora e depois a cada N minutos.
// Cada conferência baixa a página da categoria (ordenada pelos mais novos) com a sessão do Facebook
// deste Chrome e lê os dados que a própria página traz (id, título, preço, cidade, foto, data de
// criação) — sem abrir aba. Depois pede as páginas seguintes como a rolagem do Facebook faz
// (CometMarketplaceSearchContentPaginationQuery): 1 a mais a cada conferência e até 8 a cada 30 min.
// Se a página vier sem os dados, abre uma aba em segundo plano, lê e fecha.
// Envia tudo ao server.py, que guarda, filtra pelas cidades e avisa o celular dos anúncios novos.
// Só lê — nunca clica em nada no Facebook.

const RZ = 'http://localhost:5500';
const URL_CATEGORIA = 'https://www.facebook.com/marketplace/category/consoles-de-video-game/?sortBy=creation_time_descend&exact=false';
const INTERVALO_PADRAO_MIN = 3;
const PAGINAS_RAPIDA = 1;               // páginas a mais em cada conferência (~24 anúncios cada)
const PAGINAS_PROFUNDA = 8;             // varredura completa...
const PROFUNDA_A_CADA_MS = 30 * 60000;  // ...a cada 30 min
const IDADE_MAX_MS = 7 * 24 * 3600000;  // para de paginar ao chegar em anúncios com mais de 7 dias
const NOME_CONSULTA = 'CometMarketplaceSearchContentPaginationQuery';

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
    const pagina = await coletarPorRequisicao();
    anuncios = pagina.anuncios;
    if (anuncios.length) {
      const { ultimaProfunda = 0 } = await chrome.storage.local.get('ultimaProfunda');
      const profunda = Date.now() - ultimaProfunda > PROFUNDA_A_CADA_MS;
      const extras = await paginasSeguintes(pagina, profunda ? PAGINAS_PROFUNDA : PAGINAS_RAPIDA).catch((e) => {
        console.warn('[FB Radar] páginas seguintes:', e);
        return [];
      });
      const vistos = new Set(anuncios.map((a) => a.id));
      anuncios.push(...extras.filter((a) => !vistos.has(a.id)));
      metodo = `${1 + Math.ceil(extras.length / 24)} pág.${profunda ? ' (completa)' : ''}`;
      if (profunda && extras.length) await chrome.storage.local.set({ ultimaProfunda: Date.now() });
    } else {
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
  const objetos = blocos.map((b) => { try { return JSON.parse(b); } catch { return null; } }).filter(Boolean);
  return { html, anuncios: extrairDe(objetos), cursor: cursorDe(objetos) };
}

// ---------- Páginas seguintes (o mesmo pedido que a rolagem da página faz) ----------
async function paginasSeguintes({ html, cursor }, quantas) {
  const dtsg = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1];
  const lsd = /"LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] || '';
  const usuario = /"USER_ID":"(\d+)"/.exec(html)?.[1];
  const inicioParams = html.indexOf('"params":{"bqf"');
  if (!cursor || !dtsg || !usuario || inicioParams < 0) return [];
  const params = JSON.parse(objetoEm(html, inicioParams + '"params":'.length));

  let docId = (await chrome.storage.local.get('docId')).docId || await descobrirDocId(html);
  let redescobriu = false;
  const todos = [];
  for (let p = 0; p < quantas && cursor; p++) {
    const corpo = new URLSearchParams({
      av: usuario, __user: usuario, __a: '1', __comet_req: '15', fb_dtsg: dtsg, lsd,
      fb_api_caller_class: 'RelayModern', fb_api_req_friendly_name: NOME_CONSULTA, server_timestamps: 'true', doc_id: docId,
      variables: JSON.stringify({
        __relay_internal__pv__GHLShouldChangeMarketplaceSponsoredDataFieldNamerelayprovider: true,
        count: 24, cursor, params, scale: 1,
      }),
    });
    const res = await fetch('https://www.facebook.com/api/graphql/', {
      method: 'POST', credentials: 'include', body: corpo,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const objetos = (await res.text()).split('\n').map((linha) => {
      try { return JSON.parse(linha.replace(/^for \(;;\);/, '')); } catch { return null; }
    }).filter(Boolean);
    const lote = extrairDe(objetos);
    if (!lote.length) {
      // O Facebook pode ter trocado o id da consulta: descobre o novo uma vez e tenta de novo
      if (redescobriu || p > 0) break;
      redescobriu = true;
      await chrome.storage.local.remove('docId');
      docId = await descobrirDocId(html);
      p--;
      continue;
    }
    todos.push(...lote);
    cursor = cursorDe(objetos);
    const maisVelho = Math.min(...lote.map((a) => a.criadoEm || Date.now()));
    if (Date.now() - maisVelho > IDADE_MAX_MS) break;
    await new Promise((r) => setTimeout(r, 800 + Math.random() * 700)); // sem pressa entre páginas
  }
  return todos;
}

// O id da consulta fica num dos arquivos JS do Facebook listados na página: procura até achar
async function descobrirDocId(html) {
  const urls = [...new Set([...html.matchAll(/https:\\?\/\\?\/static\.xx\.fbcdn\.net\\?\/rsrc\.php\\?\/[^"'\s]+?\.js[^"'\s]*/g)]
    .map((m) => m[0].replaceAll('\\/', '/')))];
  const padrao = new RegExp(`"${NOME_CONSULTA}_facebookRelayOperation"[^]{0,120}?exports\\s*=\\s*"(\\d+)"`);
  for (const url of urls.slice(0, 150)) {
    try {
      const m = padrao.exec(await (await fetch(url)).text());
      if (m) {
        await chrome.storage.local.set({ docId: m[1] });
        return m[1];
      }
    } catch { /* arquivo que não carregou: segue para o próximo */ }
  }
  throw new Error('id da consulta de páginas não encontrado');
}

function cursorDe(objetos) {
  let cursor = null;
  const visitar = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(visitar); return; }
    if (o.edges && o.page_info?.end_cursor) cursor = o.page_info.end_cursor;
    for (const k in o) visitar(o[k]);
  };
  objetos.forEach(visitar);
  return cursor;
}

// Recorta o objeto JSON que começa em "inicio" (conta chaves, ignorando as que estão dentro de strings)
function objetoEm(texto, inicio) {
  let nivel = 0;
  let emString = false;
  let escape = false;
  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i];
    if (emString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') emString = false;
    } else if (c === '"') emString = true;
    else if (c === '{') nivel++;
    else if (c === '}' && --nivel === 0) return texto.slice(inicio, i + 1);
  }
  throw new Error('JSON incompleto');
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

function extrair(blocos) {
  return extrairDe(blocos.map((b) => { try { return JSON.parse(b); } catch { return null; } }).filter(Boolean));
}

// Percorre o JSON da página atrás dos anúncios (objetos com marketplace_listing_title)
function extrairDe(objetos) {
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
  objetos.forEach(visitar);
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
