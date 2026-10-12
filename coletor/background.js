// Rastreazera Coletor — busca automática de pedidos (Shopee, AliExpress e OLX).
//
// Ligada pelo botão "Iniciar" do painel da extensão: busca na hora e depois a cada 1 hora (e ao abrir
// o Chrome, se já passou da hora). "Parar" desliga e interrompe a busca em andamento. O botão
// "Buscar pedidos" do Rastreazera também pede uma busca (funciona mesmo com a automática parada).
//
// Cada busca: avisa o server.py, coleta Shopee e depois AliExpress numa ÚNICA aba em segundo plano
// (uma página pesada de cada vez), envia os resultados e fecha a aba. Quando as duas terminam, o
// server.py pede a Verificação Completa da OLX à extensão OLX Dashboard.
// Só lê os pedidos — nunca clica em nada nas lojas.

const RZ = 'http://localhost:5500';
const INTERVALO_MIN = 60;

const LOJAS = {
  shopee: {
    nome: 'Shopee',
    url: 'https://shopee.com.br/user/purchase/',
    login: /\/buyer\/login|\/verify\//,
  },
  aliexpress: {
    nome: 'AliExpress',
    url: 'https://www.aliexpress.com/p/order/index.html',
    login: /login\.aliexpress\.com|passport\.aliexpress\.com|\/login/,
  },
};

// ---------- Estado (chrome.storage: sobrevive ao service worker dormir) ----------
// ativo: busca automática ligada · ultimaBusca: início da última · emAndamento: { inicio, loja }
async function estado() {
  const d = await chrome.storage.local.get(['ativo', 'ultimaBusca', 'emAndamento', 'ultimoResultado']);
  return { ativo: Boolean(d.ativo), ultimaBusca: d.ultimaBusca || 0, emAndamento: d.emAndamento || null, ultimoResultado: d.ultimoResultado || null };
}

async function agendar() {
  const { ativo } = await estado();
  // Confere a cada 1 min se o Rastreazera pediu uma busca pelo botão (sempre, mesmo parada)
  chrome.alarms.create('checar', { periodInMinutes: 1 });
  if (ativo) chrome.alarms.create('busca', { periodInMinutes: INTERVALO_MIN });
  else chrome.alarms.clear('busca');
}

chrome.runtime.onInstalled.addListener(agendar);

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.remove('emAndamento'); // busca que estava rodando morreu com o Chrome
  await agendar();
  const { ativo, ultimaBusca } = await estado();
  if (ativo && Date.now() - ultimaBusca > INTERVALO_MIN * 60000) rodarBusca('abertura do Chrome');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'busca' && (await estado()).ativo) rodarBusca('automática');
  if (alarm.name === 'checar') checarSolicitacao();
});

// ---------- Painel (popup.html) ----------
chrome.runtime.onMessage.addListener((msg, _sender, responder) => {
  (async () => {
    if (msg.tipo === 'iniciar') {
      await chrome.storage.local.set({ ativo: true });
      await agendar();
      rodarBusca('botão Iniciar');
    } else if (msg.tipo === 'parar') {
      await chrome.storage.local.set({ ativo: false });
      await agendar();
      await pararBusca();
    } else if (msg.tipo === 'buscarAgora') {
      rodarBusca('botão Buscar agora');
    }
    const est = await estado();
    const alarme = await chrome.alarms.get('busca');
    responder({ ...est, proxima: alarme?.scheduledTime || null });
  })();
  return true; // resposta assíncrona
});

// ---------- Comunicação com o server.py ----------
async function api(path, dados) {
  const opcoes = dados
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) }
    : { cache: 'no-store' };
  const res = await fetch(RZ + path, opcoes);
  if (!res.ok) throw new Error(`server.py respondeu ${res.status}`);
  return res.json();
}

async function checarSolicitacao() {
  try {
    const est = await api('/api/busca/estado');
    if (est.solicitadoEm) rodarBusca('botão do Rastreazera');
  } catch { /* server.py fora do ar */ }
}

// ---------- Busca ----------
let rodando = false;
let pararSolicitado = false;
let abaColeta = null;

async function pararBusca() {
  if (!rodando) return;
  pararSolicitado = true;
  if (abaColeta) chrome.tabs.remove(abaColeta).catch(() => {});
  await api('/api/busca/cancelar', {}).catch(() => {});
}

async function rodarBusca(origem) {
  if (rodando) return;
  rodando = true;
  pararSolicitado = false;
  const inicio = Date.now();
  const resumo = {};
  try {
    // Lojas marcadas em "Onde buscar pedidos" (⚙️ do Rastreazera)
    let ativas;
    try {
      ativas = (await api('/api/config')).lojas || {};
      await api('/api/busca/iniciar', { esperadas: ['shopee', 'aliexpress', 'olx'], origem });
    } catch {
      resumo.erro = 'server.py não está rodando';
      return;
    }
    await chrome.storage.local.set({ ultimaBusca: inicio });

    for (const [fonte, loja] of Object.entries(LOJAS)) {
      if (pararSolicitado) break;
      if (ativas[fonte] === false) { resumo[fonte] = 'desmarcada'; continue; }
      await chrome.storage.local.set({ emAndamento: { inicio, loja: loja.nome } });
      let dados;
      try {
        const pedidos = (await coletarComNovaTentativa(loja)).pedidos;
        dados = { fonte, pedidos };
        resumo[fonte] = `${pedidos.length} pedido(s)`;
      } catch (e) {
        dados = { fonte, erro: e.message };
        resumo[fonte] = `erro: ${e.message}`;
      }
      if (pararSolicitado) break;
      await api('/api/busca/fonte', dados).catch(() => {});
    }
    if (!pararSolicitado) resumo.olx = ativas.olx === false ? 'desmarcada' : 'pedida à extensão OLX';
  } finally {
    if (abaColeta) { chrome.tabs.remove(abaColeta).catch(() => {}); abaColeta = null; }
    if (pararSolicitado) resumo.parada = true;
    await chrome.storage.local.set({ ultimoResultado: { ts: Date.now(), origem, ...resumo } });
    await chrome.storage.local.remove('emAndamento');
    rodando = false;
  }
}

// A aba pode sumir no meio (fechada à mão, travou): tenta mais uma vez com uma aba nova
async function coletarComNovaTentativa(loja) {
  try {
    return await coletarNaAba(loja);
  } catch (e) {
    if (pararSolicitado || !/No tab with id|tab was closed|Frame with ID/i.test(e.message)) throw e;
    abaColeta = null;
    return coletarNaAba(loja);
  }
}

function esperarCarregar(tabId, limiteMs) {
  return new Promise((resolve) => {
    const fim = () => { chrome.tabs.onUpdated.removeListener(ouvinte); clearTimeout(timer); resolve(); };
    const ouvinte = (id, info) => { if (id === tabId && info.status === 'complete') fim(); };
    const timer = setTimeout(fim, limiteMs);
    chrome.tabs.onUpdated.addListener(ouvinte);
  });
}

// Usa sempre a mesma aba em segundo plano (Shopee e depois AliExpress), fechada no fim da busca
async function abrirNaAbaDeColeta(url) {
  if (abaColeta) {
    try {
      await chrome.tabs.update(abaColeta, { url });
      return abaColeta;
    } catch { abaColeta = null; }
  }
  abaColeta = (await chrome.tabs.create({ url, active: false })).id;
  return abaColeta;
}

async function coletarNaAba(loja) {
  const tabId = await abrirNaAbaDeColeta(loja.url);
  await esperarCarregar(tabId, 30000);
  await new Promise((r) => setTimeout(r, 4000));
  if (pararSolicitado) throw new Error('busca interrompida');
  const atual = await chrome.tabs.get(tabId);
  if (loja.login.test(atual.url || '')) throw new Error('não está logado no Chrome');

  // "MAIN": roda no contexto da página (o AliExpress precisa do window.lib.mtop dela)
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['coletores.js'] });
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      try { return { ok: await coletarPedidos() }; } catch (e) { return { erro: e.message }; }
    },
  });
  if (!result || result.erro) throw new Error(result?.erro || 'falha ao coletar');
  return result.ok;
}
