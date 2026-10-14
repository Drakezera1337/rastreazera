// FB Radar — anúncios da categoria Consoles de Video Game do Facebook Marketplace.
//
// Os dados vêm do PC: a extensão FB Radar Coletor lê a categoria e o server.py guarda (fb_estado.json).
// No PC (localhost) o app lê direto do server.py (/api/fb/estado); fora dele (GitHub Pages, celular),
// lê o fb.json que o server.py publica no Gist do Rastreazera. Favoritos, ocultos e "já vi" ficam
// só neste aparelho (localStorage).
const $ = (sel) => document.querySelector(sel);
const NO_PC = ['localhost', '127.0.0.1'].includes(location.hostname);
const K = {
  dados: 'fbradar:dados',
  favoritos: 'fbradar:favoritos',
  ocultos: 'fbradar:ocultos',
  visita: 'fbradar:ultimaVisita',
  chip: 'fbradar:chip',
  ordem: 'fbradar:ordem',
  push: 'fbradar:push',
};
const ATUALIZAR_MS = NO_PC ? 20000 : 60000;

// Categorias pelo título (um anúncio pode entrar em mais de uma)
const CATEGORIAS = [
  { id: 'ps5', nome: 'PS5', re: /\bps ?5\b|playstation ?5|dualsense/ },
  { id: 'ps4', nome: 'PS4', re: /\bps ?4\b|playstation ?4|dualshock ?4/ },
  { id: 'ps3', nome: 'PS3', re: /\bps ?3\b|playstation ?3/ },
  { id: 'ps2', nome: 'PS2', re: /\bps ?2\b|playstation ?2|play ?2\b/ },
  { id: 'xbox', nome: 'Xbox', re: /x ?box|series [sx]\b/ },
  { id: 'nintendo', nome: 'Nintendo', re: /nintendo|switch|\bwii\b|wii ?u|3ds|\b2ds\b|\bds\b/ },
  { id: 'retro', nome: 'Retrô', re: /super nintendo|snes|nintendinho|\bn64\b|mega ?drive|master system|sega|atari|dreamcast|\bps ?1\b|psone|\bpsx\b|game ?boy|\bgba\b|polystation|family|retro/ },
  { id: 'portatil', nome: 'Portáteis', re: /\bpsp\b|vita|steam ?deck|rog ally|game ?boy|\b3ds\b|switch lite|r36|anbernic|miyoo/ },
  { id: 'controle', nome: 'Controles', re: /controle|joystick|dualsense|dualshock|manete|gamepad/ },
  { id: 'jogo', nome: 'Jogos', re: /\bjogos?\b|\bgames?\b|m[ií]dia|\bcd\b|fifa|gta|\bfc ?2\d/ },
];

let htmlGrade = '';
let dados = lerJSON(K.dados, null); // { anuncios, coleta, agenda, cidades, ts }
let erroCarga = '';
let carregando = false;
let chip = localStorage.getItem(K.chip) || 'todos';
const favoritos = new Set(lerJSON(K.favoritos, []));
const ocultos = new Set(lerJSON(K.ocultos, []));
// Anúncios que chegaram depois da última visita ganham o selo NOVO
const marcoNovo = Number(localStorage.getItem(K.visita)) || Date.now() - 3600000;

function lerJSON(chave, padrao) {
  try { return JSON.parse(localStorage.getItem(chave)) ?? padrao; } catch { return padrao; }
}
function gravarJSON(chave, valor) {
  try { localStorage.setItem(chave, JSON.stringify(valor)); } catch { /* armazenamento cheio/bloqueado */ }
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function hora(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
function tempoRelativo(ts) {
  if (!ts) return '';
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = new Date(ts);
  const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
  if (d.toDateString() === ontem.toDateString()) return `ontem ${hora(ts)}`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ` ${hora(ts)}`;
}
function moeda(n) {
  return n ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }) : '';
}
function linkAnuncio(a) {
  return `https://www.facebook.com/marketplace/item/${a.id}/`;
}
function categoriasDe(a) {
  const t = semAcento(a.titulo);
  return CATEGORIAS.filter((c) => c.re.test(t)).map((c) => c.id);
}

// ---------- Dados ----------
async function carregar({ manual = false } = {}) {
  if (carregando) return;
  carregando = true;
  $('#btnAtualizar').classList.add('girando');
  try {
    let novo;
    if (NO_PC) {
      const res = await fetch('/api/fb/estado', { cache: 'no-store' });
      if (!res.ok) throw new Error(`server.py respondeu ${res.status}`);
      novo = await res.json();
    } else if (Sync.enabled()) {
      novo = await Sync.lerUm('fb.json');
      if (!novo) throw new Error('o PC ainda não publicou anúncios (o FB Radar Coletor está ligado?)');
    } else {
      novo = null;
    }
    if (novo) {
      dados = novo;
      gravarJSON(K.dados, dados);
    }
    erroCarga = '';
    if (manual) toast('Atualizado');
  } catch (err) {
    erroCarga = err.message;
    if (manual) toast(`Não foi possível atualizar: ${err.message}`);
  } finally {
    carregando = false;
    $('#btnAtualizar').classList.remove('girando');
    render();
  }
}

// ---------- Tela ----------
// Vendedores repostam o mesmo anúncio várias vezes (ids diferentes, às vezes em perfis diferentes):
// mesmo título e mesmo preço viram um card só, com o mais recente na frente e o selo ×N.
// Erros de digitação ("Conttole") também contam: até 2 letras de diferença no título.
function tituloBase(a) {
  return semAcento(a.titulo).replace(/[^a-z0-9]/g, '');
}
function quaseIguais(x, y) {
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 8 || Math.abs(x.length - y.length) > 2) return false;
  let ant = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const atual = [i];
    for (let j = 1; j <= y.length; j++) {
      atual[j] = Math.min(ant[j] + 1, atual[j - 1] + 1, ant[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    ant = atual;
  }
  return ant[y.length] <= 2;
}
function agrupados() {
  const data = (a) => a.criadoEm || a.vistoEm;
  const grupos = [];
  for (const a of dados?.anuncios || []) {
    const base = tituloBase(a);
    const g = grupos.find((x) => (x.preco || 0) === (a.preco || 0) && quaseIguais(x.base, base));
    if (!g) { grupos.push({ ...a, base, ids: [a.id], primeiroVisto: a.vistoEm }); continue; }
    g.ids.push(a.id);
    g.primeiroVisto = Math.min(g.primeiroVisto, a.vistoEm);
    if (data(a) > data(g)) Object.assign(g, { ...a, base: g.base, ids: g.ids, primeiroVisto: g.primeiroVisto });
  }
  return grupos.map((g) => ({
    ...g, oculto: g.ids.some((id) => ocultos.has(id)), fav: g.ids.some((id) => favoritos.has(id)),
  }));
}

function filtrados(grupos) {
  const termos = semAcento($('#busca').value).split(/\s+/).filter(Boolean);
  const lista = grupos.filter((a) => {
    if (chip === 'ocultos') return a.oculto;
    if (a.oculto) return false;
    if (chip === 'favoritos') return a.fav;
    if (chip !== 'todos' && !categoriasDe(a).includes(chip)) return false;
    const texto = semAcento(`${a.titulo} ${a.cidade}`);
    return termos.every((t) => texto.includes(t));
  });
  const ordem = $('#ordem').value;
  const data = (a) => a.criadoEm || a.vistoEm;
  if (ordem === 'barato') lista.sort((a, b) => (a.preco || Infinity) - (b.preco || Infinity));
  else if (ordem === 'caro') lista.sort((a, b) => (b.preco || 0) - (a.preco || 0));
  else lista.sort((a, b) => data(b) - data(a));
  return lista;
}

function renderChips(grupos) {
  const todos = grupos.filter((a) => !a.oculto);
  const conta = (id) => todos.filter((a) => categoriasDe(a).includes(id)).length;
  const itens = [
    { id: 'todos', nome: 'Todos', n: todos.length },
    { id: 'favoritos', nome: '⭐ Salvos', n: todos.filter((a) => a.fav).length },
    ...CATEGORIAS.map((c) => ({ id: c.id, nome: c.nome, n: conta(c.id) })),
  ];
  const nOcultos = grupos.filter((a) => a.oculto).length;
  if (nOcultos) itens.push({ id: 'ocultos', nome: '🙈 Ocultos', n: nOcultos });
  if (!itens.some((i) => i.id === chip)) chip = 'todos';
  const html = itens
    .filter((i) => i.n || ['todos', 'favoritos'].includes(i.id) || i.id === chip)
    .map((i) => `<button type="button" class="chip${i.id === chip ? ' ativo' : ''}" data-chip="${i.id}">${esc(i.nome)}<span>${i.n}</span></button>`)
    .join('');
  if ($('#chips').innerHTML !== html) $('#chips').innerHTML = html;
}

function cardHtml(a) {
  // NOVO: apareceu depois da última visita e foi criado há pouco (a varredura completa também
  // acha anúncios antigos que ainda não estavam aqui — esses não são novidade)
  const novo = a.primeiroVisto > marcoNovo && (a.criadoEm || a.primeiroVisto) > marcoNovo - 2 * 3600000;
  const baixou = a.precoAnterior && a.preco && a.preco < a.precoAnterior;
  const selos = [
    novo ? '<span class="selo novo">NOVO</span>' : '',
    a.ids.length > 1 ? `<span class="selo" title="Postado ${a.ids.length} vezes">×${a.ids.length}</span>` : '',
    baixou ? `<span class="selo baixou">⬇ ${Math.round((1 - a.preco / a.precoAnterior) * 100)}%</span>` : '',
    a.vendido ? '<span class="selo">VENDIDO</span>' : a.reservado ? '<span class="selo">RESERVADO</span>' : '',
  ].join('');
  const preco = a.preco ? (a.precoTexto || moeda(a.preco)) : 'Sem preço';
  const { fav, oculto } = a;
  return `
    <a class="card${novo ? ' e-novo' : ''}${a.vendido ? ' vendido' : ''}" href="${linkAnuncio(a)}" target="_blank" rel="noopener" data-ids="${esc(a.ids.join(','))}">
      <div class="foto">
        ${a.foto ? `<img src="${esc(a.foto)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'sem-foto',textContent:'🎮'}))">` : '<div class="sem-foto">🎮</div>'}
        <div class="selos">${selos}</div>
      </div>
      <div class="acoes">
        <button type="button" data-acao="favorito" class="${fav ? 'marcado' : ''}" title="${fav ? 'Tirar dos salvos' : 'Salvar'}" aria-label="Salvar">${fav ? '★' : '☆'}</button>
        <button type="button" data-acao="ocultar" title="${oculto ? 'Mostrar de novo' : 'Ocultar'}" aria-label="Ocultar">${oculto ? '↩' : '✕'}</button>
      </div>
      <div class="info">
        <div class="preco">${esc(preco)}${baixou ? `<s>${esc(moeda(a.precoAnterior))}</s>` : ''}</div>
        <div class="titulo">${esc(a.titulo)}</div>
        <div class="meta">${esc(tempoRelativo(a.criadoEm || a.vistoEm))} · ${esc(a.cidade)}</div>
      </div>
    </a>`;
}

function statusColeta() {
  if (!dados) return { texto: NO_PC ? 'Sem dados ainda' : 'Não conectado', alerta: true };
  const { coleta, agenda } = dados;
  const intervalo = agenda?.intervalo || 3;
  const limite = (Math.max(intervalo * 3, 10) + (NO_PC ? 0 : 15)) * 60000;
  if (!agenda?.ativo) return { texto: '⏸ Coletor parado no PC', alerta: true, aviso: 'O FB Radar Coletor está parado. No Chrome do PC, clique no ícone dele → ▶ Iniciar.' };
  if (!coleta?.em || Date.now() - coleta.em > limite) {
    return { texto: `Sem sinal do PC desde ${coleta?.em ? tempoRelativo(coleta.em).replace('há ', '') : '—'}`, alerta: true,
      aviso: 'O coletor não confere a categoria há um tempo. O PC está ligado com o Chrome aberto?' };
  }
  if (coleta.erro) return { texto: `⚠️ ${coleta.erro}`, alerta: true, aviso: `Última conferência (${hora(coleta.em)}): ${coleta.erro}` };
  const prox = agenda.proxima && agenda.proxima > Date.now() ? ` · próxima ${hora(agenda.proxima)}` : '';
  const aviso = coleta.aviso ? `Aviso do coletor: está lendo ${coleta.aviso}` : '';
  return { texto: `Conferido às ${hora(coleta.em)}${prox}`, alerta: false, aviso };
}

function render() {
  const st = statusColeta();
  $('#status').textContent = st.texto;
  $('#status').className = `status ${st.alerta ? 'alerta' : 'ok'}`;
  const aviso = erroCarga ? `Não foi possível atualizar: ${erroCarga}` : st.aviso;
  $('#aviso').hidden = !aviso;
  $('#aviso').textContent = aviso || '';

  const grupos = agrupados();
  renderChips(grupos);
  const lista = filtrados(grupos);
  // Só redesenha a grade quando algo mudou (senão as fotos piscam a cada atualização automática)
  const html = lista.map(cardHtml).join('');
  if (html !== htmlGrade) { $('#lista').innerHTML = html; htmlGrade = html; }
  const total = grupos.length;
  const novos = grupos.filter((a) => !a.oculto && a.primeiroVisto > marcoNovo
    && (a.criadoEm || a.primeiroVisto) > marcoNovo - 2 * 3600000).length;
  const nCidades = dados?.cidades?.length || 0;
  const cidades = nCidades ? (nCidades === 1 ? dados.cidades[0] : `${nCidades} cidades`) : 'todas as cidades';
  $('#resumo').title = nCidades ? dados.cidades.join(', ') : '';
  $('#resumo').textContent = total
    ? `${lista.length} de ${total} anúncios${novos ? ` · ${novos} novo${novos > 1 ? 's' : ''} desde a última visita` : ''} · ${cidades}`
    : '';

  const vazio = $('#vazio');
  vazio.hidden = lista.length > 0;
  if (!lista.length) {
    if (!NO_PC && !Sync.enabled()) {
      vazio.innerHTML = `<span class="grande">🔗</span><p>Conecte este aparelho ao PC para ver os anúncios.</p>
        <p class="dica">No PC: FB Radar → ⚙️ → Mostrar QR code. Aqui: ⚙️ → Ler QR do PC.</p>
        <button type="button" id="btnConectarVazio" class="primario">Conectar</button>`;
    } else if (!total) {
      vazio.innerHTML = `<span class="grande">📡</span><p>Nenhum anúncio ainda.</p>
        <p class="dica">Instale a extensão <strong>FB Radar Coletor</strong> no Chrome do PC (pasta <code>fb/coletor</code>), entre no Facebook e clique em ▶ Iniciar.</p>`;
    } else {
      vazio.innerHTML = `<span class="grande">🔍</span><p>Nada com esse filtro.</p>`;
    }
  }
}

$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chip]');
  if (!b) return;
  chip = b.dataset.chip;
  localStorage.setItem(K.chip, chip);
  render();
});
$('#busca').addEventListener('input', render);
$('#ordem').value = localStorage.getItem(K.ordem) || 'novos';
$('#ordem').addEventListener('change', () => { localStorage.setItem(K.ordem, $('#ordem').value); render(); });
$('#btnAtualizar').addEventListener('click', () => carregar({ manual: true }));
$('#status').addEventListener('click', () => carregar({ manual: true }));

$('#lista').addEventListener('click', (e) => {
  const b = e.target.closest('[data-acao]');
  if (!b) return;
  e.preventDefault();
  // Vale para o grupo todo (reposts); um repost novo de um grupo oculto continua oculto
  const ids = b.closest('.card').dataset.ids.split(',');
  const conjunto = b.dataset.acao === 'favorito' ? favoritos : ocultos;
  const marcar = !ids.some((id) => conjunto.has(id));
  ids.forEach((id) => (marcar ? conjunto.add(id) : conjunto.delete(id)));
  gravarJSON(b.dataset.acao === 'favorito' ? K.favoritos : K.ocultos, [...conjunto]);
  if (b.dataset.acao === 'ocultar' && marcar) toast('Anúncio oculto (veja em 🙈 Ocultos)');
  render();
});
$('#vazio').addEventListener('click', (e) => { if (e.target.id === 'btnConectarVazio') abrirConfig(); });

// "Última visita": ao sair do app, o que já tinha chegado à tela deixa de ser NOVO na próxima vez
function registrarVisita() {
  const ultimo = Math.max(0, ...(dados?.anuncios || []).map((a) => a.vistoEm || 0));
  if (ultimo > (Number(localStorage.getItem(K.visita)) || 0)) localStorage.setItem(K.visita, String(ultimo));
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) registrarVisita();
  else carregar();
});
window.addEventListener('pagehide', registrarVisita);

setInterval(() => { if (!document.hidden) carregar(); }, ATUALIZAR_MS);
setInterval(() => { if (!document.hidden) render(); }, 60000); // "há X min"

// ---------- Configurações ----------
const dlg = $('#dlgConfig');
function abrirConfig() {
  $('#secCidades').hidden = !NO_PC;
  $('#secQr').hidden = !NO_PC;
  $('#secConectar').hidden = NO_PC;
  if (NO_PC) $('#cidades').value = (dados?.cidades || []).join('\n');
  $('#versao').textContent = `Versão ${typeof RZ_VERSAO === 'number' ? RZ_VERSAO : '?'}${NO_PC ? ' · no PC' : ''}`;
  renderNotif();
  dlg.showModal();
}
$('#btnConfig').addEventListener('click', abrirConfig);
dlg.addEventListener('close', () => { pararLeitorQr(); $('#qrCodigo').hidden = true; $('#qrCodigo').innerHTML = ''; });

$('#btnSalvarCidades').addEventListener('click', async () => {
  const cidades = $('#cidades').value.split('\n').map((c) => c.trim()).filter(Boolean);
  try {
    const res = await fetch('/api/fb/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cidades }) });
    if (!res.ok) throw new Error(`erro ${res.status}`);
    toast('Cidades salvas — valem a partir da próxima conferência');
    carregar();
  } catch (err) {
    toast(`Não foi possível salvar: ${err.message}`);
  }
});

// ---------- Notificações (push enviado pelo server.py do PC; inscrição em push_fb.json no Gist) ----------
function pushSuportado() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function chaveParaBytes(b64url) {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function descreverAparelho() {
  const ua = navigator.userAgent;
  const tipo = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Computador';
  return `${tipo} · FB Radar (ativado em ${new Date().toLocaleDateString('pt-BR')})`;
}
function renderNotif() {
  const inscricao = lerJSON(K.push, null);
  const ativo = Boolean(inscricao) && pushSuportado() && Notification.permission === 'granted';
  $('#notifStatus').textContent = !pushSuportado()
    ? '⚠️ Este navegador não suporta notificações. No iPhone, abra o FB Radar pelo ícone da tela de início (iOS 16.4 ou mais novo).'
    : ativo ? '✅ Notificações ativas neste aparelho.'
      : Notification.permission === 'denied' ? '🚫 Notificações bloqueadas: libere nas configurações do celular/navegador.'
        : 'Notificações desligadas neste aparelho.';
  $('#btnAtivarPush').hidden = ativo || !pushSuportado() || Notification.permission === 'denied';
  $('#btnTestarPush').hidden = !ativo;
  $('#btnDesativarPush').hidden = !ativo;
}

$('#btnAtivarPush').addEventListener('click', async () => {
  if (!Sync.enabled()) return toast(NO_PC ? 'Ative a sincronização no Rastreazera (⚙️) primeiro' : 'Conecte ao PC primeiro (Ler QR do PC)');
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') { renderNotif(); return toast('Sem permissão para notificar'); }
  try {
    const reg = await navigator.serviceWorker.getRegistration('./') || await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(RZ_CONFIG.pushChavePublica) });
    const { endpoint, keys } = sub.toJSON();
    const registro = { endpoint, keys, aparelho: descreverAparelho(), criadoEm: Date.now() };
    await Sync.atualizarInscricao(endpoint, registro, 'push_fb.json');
    gravarJSON(K.push, registro);
    toast('Notificações ativadas neste aparelho');
  } catch (err) {
    toast(`Não foi possível ativar: ${err.message}`);
  }
  renderNotif();
});

$('#btnTestarPush').addEventListener('click', async () => {
  const registro = lerJSON(K.push, null);
  if (!registro) return renderNotif();
  try {
    await Sync.atualizarInscricao(registro.endpoint, { ...registro, testeEm: Date.now() }, 'push_fb.json');
    toast('Teste pedido ao PC — chega em até 1 min (com o PC ligado)');
  } catch (err) {
    toast(`Não foi possível pedir o teste: ${err.message}`);
  }
});

$('#btnDesativarPush').addEventListener('click', async () => {
  const registro = lerJSON(K.push, null);
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    if (registro) await Sync.atualizarInscricao(registro.endpoint, null, 'push_fb.json');
  } catch { /* segue desligando localmente */ }
  gravarJSON(K.push, null);
  renderNotif();
  toast('Notificações desativadas neste aparelho');
});

// ---------- Celular: QR code com o token e o Gist (o mesmo do Rastreazera) ----------
// O QR abre o FB Radar publicado com #config=…; o fragmento (#) não vai a nenhum servidor e é apagado ao ler.
function base64url(texto) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(texto))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deBase64url(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function carregarScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('sem conexão'));
    document.head.appendChild(s);
  });
}

let qrScript;
$('#btnMostrarQr').addEventListener('click', async () => {
  const caixa = $('#qrCodigo');
  if (!caixa.hidden) { caixa.hidden = true; caixa.innerHTML = ''; return; }
  if (!Sync.enabled()) return toast('Ative a sincronização no Rastreazera (⚙️) primeiro');
  const { token, gistId } = Sync.config();
  const url = `${RZ_CONFIG.sitePublico}fb/#config=${base64url(JSON.stringify({ token, gistId }))}`;
  try {
    qrScript ??= carregarScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js').catch((e) => { qrScript = null; throw e; });
    await qrScript;
  } catch {
    return toast('Não foi possível carregar o gerador de QR code');
  }
  caixa.innerHTML = '';
  new QRCode(caixa, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
  caixa.hidden = false;
});

function aplicarLinkConfig(texto) {
  const match = String(texto || '').match(/#config=([\w-]+)/);
  if (!match) return false;
  try {
    const { token, gistId } = JSON.parse(deBase64url(match[1]));
    if (!token || !gistId) throw new Error();
    Sync.setConfig({ token, gistId });
    toast('Conectado ao PC — carregando anúncios…');
    return true;
  } catch {
    toast('Link de configuração inválido');
    return false;
  }
}
function configurarPorLink(texto) {
  if (!aplicarLinkConfig(texto)) return;
  dlg.close();
  carregar();
}
$('#linkConfig').addEventListener('change', (e) => { configurarPorLink(e.target.value); e.target.value = ''; });

let leitorStream = null;
let jsQrScript;
function pararLeitorQr() {
  leitorStream?.getTracks().forEach((t) => t.stop());
  leitorStream = null;
  $('#leitorQr').hidden = true;
}
$('#btnPararQr').addEventListener('click', pararLeitorQr);
$('#btnLerQr').addEventListener('click', async () => {
  const video = $('#videoQr');
  try {
    leitorStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return toast('Sem acesso à câmera — permita nas configurações ou cole o link abaixo');
  }
  video.srcObject = leitorStream;
  $('#leitorQr').hidden = false;
  await video.play().catch(() => {});

  let ler;
  if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.())?.includes('qr_code')) {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    ler = async () => (await detector.detect(video))[0]?.rawValue;
  } else {
    try {
      jsQrScript ??= carregarScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js').catch((e) => { jsQrScript = null; throw e; });
      await jsQrScript;
    } catch {
      pararLeitorQr();
      return toast('Não foi possível carregar o leitor de QR — cole o link abaixo');
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ler = async () => {
      if (!video.videoWidth) return null;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
    };
  }
  while (leitorStream) {
    const texto = await ler().catch(() => null);
    if (texto?.includes('#config=')) {
      pararLeitorQr();
      return configurarPorLink(texto);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
});

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- Início ----------
if (location.hash.startsWith('#config=')) {
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  aplicarLinkConfig(hash);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
carregar();
