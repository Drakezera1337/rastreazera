const STORAGE_KEY = 'rastreazera:pacotes';

const STATUS = {
  aguardando: { label: 'Aguardando postagem', icon: '🕓' },
  transito: { label: 'Em trânsito', icon: '🚚' },
  fiscalizacao: { label: 'Fiscalização / taxado', icon: '🛃' },
  saiu: { label: 'Saiu para entrega', icon: '📍' },
  entregue: { label: 'Entregue', icon: '✅' },
  problema: { label: 'Problema', icon: '⚠️' },
};

const $ = (sel) => document.querySelector(sel);
const state = {
  items: load(), // inclui itens apagados (deleted: true) para a sincronização saber da exclusão
  filter: 'ativos',
  query: '',
};

// ---------- Persistência ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }
}
function save({ sync = true } = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
  render();
  if (sync) scheduleSync();
}
function visibleItems() {
  return state.items.filter((p) => !p.deleted);
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------- Renderização ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function daysSince(ts) {
  return Math.floor((Date.now() - ts) / 86400000);
}

function matchesFilter(p) {
  switch (state.filter) {
    case 'ativos': return p.status !== 'entregue';
    case 'entregue': return p.status === 'entregue';
    case 'problema': return p.status === 'problema' || p.status === 'fiscalizacao';
    default: return true;
  }
}
function matchesQuery(p) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [p.name, p.code, p.store, p.notes, CARRIERS[p.carrier]?.name].some((v) => String(v || '').toLowerCase().includes(q));
}

// Ordenação escolhida no seletor "Ordenar" (guardada neste aparelho)
const ORDEM_KEY = 'rastreazera:ordem';
const porNome = (a, b) => (a.name || a.code).localeCompare(b.name || b.code, 'pt-BR', { sensitivity: 'base', numeric: true });
const ultimaAtualizacao = (p) => p.lastEvent?.time || p.updatedAt || p.createdAt;
const ORDENS = {
  recente: (a, b) => ultimaAtualizacao(b) - ultimaAtualizacao(a),
  nome: porNome,
  plataforma: (a, b) => plataforma(a).nome.localeCompare(plataforma(b).nome, 'pt-BR', { sensitivity: 'base' }) || porNome(a, b),
};
state.ordem = (() => { try { return localStorage.getItem(ORDEM_KEY); } catch { return null; } })();
if (!ORDENS[state.ordem]) state.ordem = 'recente';

function render() {
  const all = visibleItems();
  const list = all
    .filter(matchesFilter)
    .filter(matchesQuery)
    .sort((a, b) => (a.status === 'entregue') - (b.status === 'entregue') || ORDENS[state.ordem](a, b));

  const ativos = all.filter((p) => p.status !== 'entregue').length;
  $('#stats').innerHTML = all.length
    ? `<span><strong>${ativos}</strong> a caminho</span><span><strong>${all.length - ativos}</strong> entregue(s)</span>`
    : '';

  if (!list.length) {
    $('#list').innerHTML = all.length
      ? '<p class="empty">Nenhum rastreio neste filtro.</p>'
      : `<div class="empty">
           <p class="empty-big">📦</p>
           <p>Nenhum rastreio ainda.</p>
           ${!Sync.enabled() && !TEM_SERVIDOR
             ? '<p>Seus pacotes estão no PC? Toque em <strong>⚙️</strong> → <strong>📷 Ler QR do PC</strong>.</p>'
             : '<p>Toque em <strong>＋</strong> e cole o código de rastreio.</p>'}
         </div>`;
    return;
  }

  $('#list').innerHTML = list.map(cardHtml).join('');
}

// Cor de cada plataforma (loja); sem loja informada, usa a transportadora
const PLATAFORMAS = {
  shopee: '#ee4d2d', aliexpress: '#ff6a00', olx: '#8b5cf6', 'mercado livre': '#eab308',
  amazon: '#f59e0b', shein: '#64748b', temu: '#f97316', magalu: '#0086ff',
};

function plataforma(p) {
  const carrier = CARRIERS[p.carrier] || CARRIERS.outra;
  const nome = p.store || carrier.name;
  return { nome, cor: PLATAFORMAS[nome.toLowerCase()] || (p.store ? '#64748b' : carrier.color) };
}

function tempoRelativo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
  const dias = Math.round(min / 1440);
  return dias < 7 ? `há ${dias} dia${dias === 1 ? '' : 's'}` : fmtDate(ts);
}

function statusBadge(p) {
  const s = STATUS[p.status] || STATUS.aguardando;
  return `<span class="status-badge st-${p.status}">${s.icon} ${s.label}</span>`;
}

function cardHtml(p) {
  const carrier = CARRIERS[p.carrier] || CARRIERS.outra;
  const plat = plataforma(p);
  const ultima = p.lastEvent
    ? `<span class="ultima-texto">${esc(p.lastEvent.text)}</span>
       <time datetime="${new Date(p.lastEvent.time).toISOString()}" title="${fmtDateTime(p.lastEvent.time)}">${tempoRelativo(p.lastEvent.time)}</time>`
    : '<span class="ultima-texto vazio">Sem atualizações ainda</span>';
  const nome = esc(p.name || p.code);
  return `
    <article class="card status-${p.status}" data-id="${p.id}" data-action="abrir" tabindex="0" role="button" aria-label="Detalhes de ${nome}">
      <div class="card-topo">
        <h3>${nome}</h3>
        <span class="badge" style="--c:${plat.cor}">${esc(plat.nome)}</span>
      </div>
      ${statusBadge(p)}
      <p class="card-ultima">${ultima}</p>
      <div class="card-acoes">
        <a class="acao" href="${carrier.url(p.code)}" target="_blank" rel="noopener" title="Site oficial (${esc(carrier.name)})" aria-label="Abrir no site oficial">↗</a>
        <button class="acao" data-action="edit" title="Editar" aria-label="Editar ${nome}">✏️</button>
        <button class="acao perigo" data-action="delete" title="Excluir" aria-label="Excluir ${nome}">🗑️</button>
      </div>
    </article>`;
}

// ---------- Formulário ----------
const dlg = $('#dlgPacote');
const form = $('#formPacote');

function fillSelects() {
  $('#carrierSelect').innerHTML =
    '<option value="">Detectar automaticamente</option>' +
    Object.entries(CARRIERS).map(([k, c]) => `<option value="${k}">${c.name}</option>`).join('');
  $('#statusSelect').innerHTML = Object.entries(STATUS).map(([k, s]) => `<option value="${k}">${s.icon} ${s.label}</option>`).join('');
}

function openForm(p) {
  form.reset();
  $('#dlgTitle').textContent = p ? 'Editar rastreio' : 'Novo rastreio';
  form.pid.value = p?.id || '';
  form.code.value = p?.code || '';
  form.name.value = p?.name || '';
  form.store.value = p?.store || '';
  form.carrier.value = p?.carrier || '';
  form.status.value = p?.status || 'transito';
  form.eta.value = p?.eta || '';
  form.notes.value = p?.notes || '';
  updateHint();
  // Editando: o nome vem primeiro (o código já está certo). Novo: o código primeiro (é o que se cola).
  const [primeiro, segundo] = p ? [$('#campoNome'), $('#campoCodigo')] : [$('#campoCodigo'), $('#campoNome')];
  $('#dlgTitle').after(primeiro);
  primeiro.after(segundo);
  dlg.showModal();
  (p ? form.name : form.code).focus();
}

function updateHint() {
  const code = normalizeCode(form.code.value);
  const key = detectCarrier(code);
  $('#carrierHint').textContent = key ? `Detectado: ${CARRIERS[key].name}` : '';
}

form.code.addEventListener('input', updateHint);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normalizeCode(form.code.value);
  if (!code) return;
  const id = form.pid.value;
  const dup = visibleItems().find((p) => p.code === code && p.id !== id);
  if (dup && !confirm(`Esse código já está cadastrado (${dup.name || 'sem nome'}). Salvar mesmo assim?`)) return;

  const data = {
    code,
    name: form.name.value.trim(),
    store: form.store.value.trim(),
    carrier: form.carrier.value || detectCarrier(code),
    status: form.status.value,
    eta: form.eta.value,
    notes: form.notes.value.trim(),
    updatedAt: Date.now(),
  };

  let novo = null;
  if (id) {
    Object.assign(state.items.find((p) => p.id === id), data);
    toast('Rastreio atualizado');
  } else {
    novo = { id: uid(), createdAt: Date.now(), ...data };
    state.items.push(novo);
    toast('Rastreio adicionado');
  }
  dlg.close();
  save();
  if (novo) showTracking(novo); // já mostra o resultado do rastreio recém-cadastrado
});

// ---------- Resultado do rastreio ----------
// Transportadoras com consulta própria (trackers.js) mostram a linha do tempo aqui e atualizam o status.
// As demais usam o widget oficial do 17TRACK.
const dlgTrack = $('#dlgTrack');
let widgetScript;

async function refreshItem(p) {
  const result = await Trackers.fetch(p);
  if (result.pendente) { // Correios recém-cadastrado na Ship24: os dados chegam em alguns minutos
    p.lastCheck = Date.now() - 25 * 60000; // tenta de novo em ~5 min (refreshAll)
    return { ...result, status: p.status, events: p.events || [] };
  }
  const last = result.events[0];
  // Correios: guarda o histórico (o celular mostra mesmo sem consultar); Shopee o celular consulta pelo Worker
  if (p.carrier !== 'shopee' && result.events.length) {
    p.events = result.events.slice(0, 60);
    p.eventsAt = Date.now();
    p.fonteEventos = 'correios';
  }
  if (p.status !== result.status && STATUS[result.status]) {
    const texto = `${p.name || p.code}: ${STATUS[result.status].icon} ${STATUS[result.status].label}`;
    // Só no 🔔 do app: notificação do sistema sai apenas ao fim da busca completa (depois da OLX),
    // enviada pelo server.py do PC
    adicionarNotificacao('status', texto);
  }
  p.status = result.status;
  p.lastEvent = last ? { text: last.text, time: last.time } : null;
  p.lastCheck = Date.now();
  p.updatedAt = Date.now();
  save();
  return result;
}

// Atualiza em segundo plano os pacotes a caminho (no máximo a cada 30 min por pacote)
async function refreshAll() {
  const due = visibleItems().filter(
    (p) => Trackers.supports(p) && p.status !== 'entregue' && Date.now() - (p.lastCheck || 0) > 30 * 60000
  );
  for (const p of due) {
    try { await refreshItem(p); } catch { /* tenta de novo na próxima vez */ }
  }
}

function timelineHtml(events) {
  if (!events.length) return '<p class="empty">Ainda não há movimentações.</p>';
  return `<ol class="timeline">${events.map((ev) => `
    <li>
      <p class="tl-text">${esc(ev.text)}</p>
      <p class="tl-meta">${fmtDateTime(ev.time)}${ev.location ? ` · ${esc(ev.location)}` : ''}</p>
    </li>`).join('')}</ol>`;
}

function loadWidget() {
  widgetScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://www.17track.net/externalcall.js';
    s.onload = resolve;
    s.onerror = () => { widgetScript = null; reject(new Error('sem conexão com o 17TRACK')); };
    document.head.appendChild(s);
  });
  return widgetScript;
}

// Pacote aberto no modal de detalhes
let pacoteAberto = null;

function renderDetalhes(p) {
  const carrier = CARRIERS[p.carrier] || CARRIERS.outra;
  const plat = plataforma(p);
  $('#trackTitle').textContent = p.name || p.code;
  $('#trackSub').innerHTML = `<span class="badge" style="--c:${plat.cor}">${esc(plat.nome)}</span> ${statusBadge(p)}`;
  $('#trackOfficial').href = carrier.url(p.code);
  const linha = (rotulo, valor, cheia) => valor ? `<div class="${cheia ? 'cheia' : ''}"><dt>${rotulo}</dt><dd>${valor}</dd></div>` : '';
  const dias = daysSince(p.createdAt);
  $('#trackDetalhes').innerHTML = `
    <dl class="det-grid">
      ${linha('Código de rastreio', `<button type="button" class="code" data-det="copiar" title="Copiar código">${esc(p.code)} <span aria-hidden="true">⧉</span></button>`)}
      ${linha('Transportadora', esc(carrier.name))}
      ${linha('Status', `<select data-det="status" aria-label="Status">${Object.entries(STATUS).map(([k, s]) =>
        `<option value="${k}" ${k === p.status ? 'selected' : ''}>${s.icon} ${s.label}</option>`).join('')}</select>`)}
      ${linha('Previsão de entrega', p.eta && new Date(`${p.eta}T12:00`).toLocaleDateString('pt-BR'))}
      ${linha('Última atualização', p.lastEvent && `${esc(p.lastEvent.text)}<br><small>${fmtDateTime(p.lastEvent.time)} (${tempoRelativo(p.lastEvent.time)})</small>`, true)}
      ${linha('Observações', p.notes && esc(p.notes).replace(/ · /g, '<br>'), true)}
      ${linha('Adicionado em', `${fmtDate(p.createdAt)} <small>(${dias} dia${dias === 1 ? '' : 's'})</small>`)}
    </dl>`;
}

$('#trackDetalhes').addEventListener('click', async (e) => {
  if (!e.target.closest('[data-det="copiar"]') || !pacoteAberto) return;
  try { await navigator.clipboard.writeText(pacoteAberto.code); toast('Código copiado'); }
  catch { prompt('Copie o código:', pacoteAberto.code); }
});
$('#trackDetalhes').addEventListener('change', (e) => {
  if (e.target.dataset.det !== 'status' || !pacoteAberto) return;
  pacoteAberto.status = e.target.value;
  pacoteAberto.updatedAt = Date.now();
  save();
  renderDetalhes(pacoteAberto);
  toast('Status atualizado');
});
$('#trackEditar').addEventListener('click', () => {
  const p = pacoteAberto;
  dlgTrack.close();
  if (p) openForm(p);
});
dlgTrack.addEventListener('close', () => { pacoteAberto = null; });

async function showTracking(p) {
  const carrier = CARRIERS[p.carrier] || CARRIERS.outra;
  pacoteAberto = p;
  renderDetalhes(p);
  const box = $('#trackResult');
  box.innerHTML = '<p class="empty">Buscando rastreio…</p>';
  box.classList.remove('widget');
  if (!dlgTrack.open) dlgTrack.showModal();
  $('.track-corpo').scrollTop = 0;

  if (Trackers.supports(p)) {
    try {
      const result = await refreshItem(p);
      if (pacoteAberto === p) renderDetalhes(p); // a consulta pode ter trazido status/evento novos
      box.innerHTML = result.pendente && !result.events.length
        ? '<p class="empty">Código cadastrado na Ship24 agora — os dados dos Correios chegam em alguns minutos. Abra de novo daqui a pouco.</p>'
        : timelineHtml(result.events);
    } catch (err) {
      box.innerHTML = `<p class="empty">Não foi possível consultar (${esc(err.message)}).<br>
        Use o botão “Site da transportadora”.</p>`;
    }
    return;
  }

  // Shopee sem proxy: o 17TRACK não rastreia a SPX Brasil — mostra o que a busca automática trouxe
  if (p.carrier === 'shopee') {
    box.innerHTML = `
      <p class="track-note">Consulta completa da Shopee indisponível aqui (falta o proxy em ⚙️). Último evento trazido pela busca de pedidos:</p>
      ${timelineHtml(p.lastEvent ? [p.lastEvent] : [])}`;
    return;
  }

  // Histórico guardado: da importação da loja (AliExpress) ou dos Correios pela Ship24 (o PC atualiza
  // a cada busca). Opção de abrir o widget do 17TRACK para conferir na hora.
  const correios = ['correios', 'postal_intl'].includes(p.carrier);
  if (p.events?.length) {
    const origem = p.fonteEventos === 'correios'
      ? `Correios, atualizado pelo PC em ${fmtDateTime(p.eventsAt || p.updatedAt)}.`
      : `Histórico da importação do ${esc(p.store || 'pedido')} em ${fmtDateTime(p.eventsAt || p.updatedAt)}.`;
    box.innerHTML = `
      <p class="track-note">${origem}
        <button type="button" class="btn small" id="btnWidget">Conferir no 17TRACK</button>
      </p>
      ${timelineHtml(p.events)}`;
    $('#btnWidget').addEventListener('click', () => showWidget(p, carrier));
    return;
  }
  if (correios) {
    // Ainda sem histórico: o PC consulta a Ship24 na próxima busca (precisa da chave em ⚙️ no PC)
    box.innerHTML = `
      <p class="empty">O histórico dos Correios aparece aqui depois da próxima busca do PC.<br>
        <button type="button" class="btn small" id="btnWidget">Ver agora no 17TRACK</button></p>`;
    $('#btnWidget').addEventListener('click', () => showWidget(p, carrier));
    return;
  }
  showWidget(p, carrier);
}

async function showWidget(p, carrier) {
  const box = $('#trackResult');
  box.innerHTML = '<p class="empty">Buscando rastreio…</p>';
  try {
    await loadWidget();
    box.innerHTML = '';
    box.classList.add('widget');
    YQV5.trackSingle({
      YQ_ContainerId: 'trackResult',
      YQ_Height: 460,
      YQ_Fc: carrier.yq || '0', // '0' = o 17TRACK tenta descobrir a transportadora
      YQ_Lang: 'pt',
      YQ_Num: p.code,
    });
  } catch (err) {
    box.innerHTML = `<p class="empty">Não foi possível carregar o rastreio (${esc(err.message)}).<br>
      Use o botão “Site da transportadora”.</p>`;
  }
}

// ---------- Ações nos cards ----------
// Clicar no corpo do card abre os detalhes; os ícones fazem a ação deles; o ↗ é um link normal
function excluirPacote(p) {
  if (!confirm(`Excluir "${p.name || p.code}"?`)) return false;
  // Mantém só o necessário para a exclusão se propagar na sincronização
  Object.keys(p).forEach((k) => { if (!['id', 'createdAt'].includes(k)) delete p[k]; });
  Object.assign(p, { deleted: true, updatedAt: Date.now() });
  save();
  toast('Rastreio excluído');
  return true;
}

$('#list').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const alvo = e.target.closest('[data-action]');
  const card = e.target.closest('.card');
  if (!alvo || !card) return;
  const p = state.items.find((x) => x.id === card.dataset.id);
  if (alvo.dataset.action === 'edit') openForm(p);
  else if (alvo.dataset.action === 'delete') excluirPacote(p);
  else if (alvo.dataset.action === 'abrir') showTracking(p);
});

$('#list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('card')) {
    e.preventDefault();
    showTracking(state.items.find((x) => x.id === e.target.dataset.id));
  }
});

// ---------- Busca e filtros ----------
$('#search').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
$('#ordem').value = state.ordem;
$('#ordem').addEventListener('change', (e) => {
  state.ordem = e.target.value;
  try { localStorage.setItem(ORDEM_KEY, state.ordem); } catch { /* sem storage: vale só nesta sessão */ }
  render();
});
$('#filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
  state.filter = chip.dataset.filter;
  render();
});

// ---------- Diálogos ----------
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
});
$('#btnAdd').addEventListener('click', () => openForm());

// Colar um código direto na página (Ctrl+V fora de campos) já abre o formulário
document.addEventListener('paste', (e) => {
  if (document.querySelector('dialog[open]') || e.target.closest('input, textarea')) return;
  const text = normalizeCode(e.clipboardData.getData('text'));
  if (/^[A-Z0-9]{8,30}$/.test(text)) {
    openForm();
    form.code.value = text;
    updateHint();
    form.name.focus();
  }
});

// ---------- Configurações / sincronização ----------
const dlgSettings = $('#dlgSettings');
const formSettings = $('#formSettings');

$('#btnSettings').addEventListener('click', () => {
  const cfg = Sync.config();
  formSettings.token.value = cfg.token || '';
  formSettings.gistId.value = cfg.gistId || '';
  formSettings.proxy.value = localStorage.getItem('rastreazera:proxy') || '';
  carregarLojasBusca();
  renderNotifAparelho();
  $('#secaoCorreios').hidden = !TEM_SERVIDOR;
  if (TEM_SERVIDOR) fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).then((c) => mostrarChaveCorreios(c.rastreioConfigurado)).catch(() => {});
  dlgSettings.showModal();
});

// ---------- Onde buscar pedidos (guardado no server.py: vale também para a extensão Coletor) ----------
const caixasLojas = () => [...document.querySelectorAll('#lojasBusca input[name=loja]')];

// ---------- Chave da Ship24 (Correios) — só no PC, guardada pelo server.py ----------
function mostrarChaveCorreios(configurada) {
  Trackers.setCorreiosAtivo(configurada);
  $('#secaoCorreios').hidden = !TEM_SERVIDOR;
  $('#correiosStatus').textContent = configurada
    ? '✅ Chave configurada: os Correios são consultados pela Ship24.'
    : 'Sem chave: os Correios aparecem só pelo widget do 17TRACK.';
  $('#btnCorreiosRemover').hidden = !configurada;
  $('#correiosChave').value = '';
}

async function salvarChaveCorreios(chave) {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ship24: chave }),
    });
    if (!res.ok) throw new Error();
    const cfg = await (await fetch('/api/config', { cache: 'no-store' })).json();
    mostrarChaveCorreios(cfg.rastreioConfigurado);
    if (chave && !cfg.rastreioConfigurado) return toast('Chave inválida (confira se copiou inteira)');
    toast(chave ? 'Chave da Ship24 salva' : 'Chave da Ship24 removida');
    if (chave) refreshAll();
  } catch {
    toast('Não foi possível salvar — o server.py está rodando?');
  }
}

$('#btnCorreiosSalvar').addEventListener('click', () => {
  const chave = $('#correiosChave').value.trim();
  if (!chave) return toast('Cole a chave da API da Ship24');
  salvarChaveCorreios(chave);
});
$('#btnCorreiosRemover').addEventListener('click', () => salvarChaveCorreios(null));

// Caixa marcada = loja ativa nas buscas. No PC, lê/grava direto no server.py; no celular, lê o que
// o PC publicou no Gist (andamento.json → lojasAtivas) e grava em config.json, que o PC aplica em até 1 min.
function mostrarLojas(lojas, aviso = '') {
  caixasLojas().forEach((c) => { c.checked = lojas[c.value] !== false; });
  $('#lojasBusca').classList.remove('desabilitado');
  $('#lojasBuscaAviso').textContent = aviso;
  $('#lojasBuscaAviso').hidden = !aviso;
}

function lojasBloqueadas(aviso) {
  $('#lojasBusca').classList.add('desabilitado');
  $('#lojasBuscaAviso').textContent = aviso;
  $('#lojasBuscaAviso').hidden = false;
}

async function carregarLojasBusca() {
  if (TEM_SERVIDOR) {
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      return mostrarLojas((await res.json()).lojas);
    } catch {
      return lojasBloqueadas('Não foi possível falar com o server.py.');
    }
  }
  if (!Sync.enabled()) return lojasBloqueadas('Ligue a sincronização (⚙️ → Ler QR do PC) para escolher daqui.');
  lojasBloqueadas('Carregando…');
  try {
    const remoto = await Sync.pull();
    const doPc = remoto.andamento?.lojasAtivas;
    // Mudança feita aqui que o PC ainda não aplicou: mostra a escolha nova
    const iguais = (a, b) => a && b && ORDEM_FONTES.every((l) => (a[l] !== false) === (b[l] !== false));
    const pendente = remoto.config?.ts > (remoto.andamento?.ts || 0) && !iguais(remoto.config.lojas, doPc)
      ? remoto.config.lojas : null;
    if (pendente) mostrarLojas(pendente, 'Salvo — o PC aplica na próxima conferência (até 1 min, com o PC ligado).');
    else if (doPc) mostrarLojas(doPc);
    else lojasBloqueadas('O PC ainda não informou as lojas ativas (ele precisa estar ligado).');
  } catch (err) {
    lojasBloqueadas(`Não foi possível ler do GitHub: ${err.message}`);
  }
}

$('#lojasBusca').addEventListener('change', async (e) => {
  const caixa = e.target;
  const nome = FONTES[caixa.value];
  try {
    if (TEM_SERVIDOR) {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lojas: { [caixa.value]: caixa.checked } }),
      });
      if (!res.ok) throw new Error();
      toast(caixa.checked ? `${nome} ativada nas buscas` : `${nome} desativada das buscas`);
    } else {
      const lojas = Object.fromEntries(caixasLojas().map((c) => [c.value, c.checked]));
      await Sync.salvarConfigLojas(lojas);
      mostrarLojas(lojas, 'Salvo — o PC aplica na próxima conferência (até 1 min, com o PC ligado).');
      toast(caixa.checked ? `${nome} ativada — o PC aplica em até 1 min` : `${nome} desativada — o PC aplica em até 1 min`);
    }
  } catch {
    caixa.checked = !caixa.checked;
    toast('Não foi possível salvar a escolha');
  }
});

$('#btnProxySave').addEventListener('click', () => {
  Trackers.setProxyUrl(formSettings.proxy.value);
  toast(formSettings.proxy.value ? 'Proxy salvo' : 'Proxy removido');
  refreshAll();
});

$('#btnSyncSave').addEventListener('click', async () => {
  const token = formSettings.token.value.trim();
  let gistId = formSettings.gistId.value.trim();
  if (!token) return toast('Informe o token do GitHub');
  try {
    setSyncStatus('busy');
    if (!gistId) {
      // Reaproveita o Gist do Rastreazera que já existe (o mesmo do PC); só cria se não houver nenhum
      gistId = await Sync.encontrarExistente(token);
      if (gistId) toast('Usando o Gist do Rastreazera que já existia na sua conta');
      else gistId = await Sync.create(token, state.items);
      formSettings.gistId.value = gistId;
    }
    Sync.setConfig({ token, gistId });
    await syncNow();
    await enviarGistAoServidor();
    toast('Sincronização ativada');
  } catch (err) {
    setSyncStatus('error');
    toast(`Falha: ${err.message}`);
  }
});

$('#btnSyncOff').addEventListener('click', () => {
  Sync.setConfig(null);
  enviarGistAoServidor(null);
  formSettings.token.value = '';
  formSettings.gistId.value = '';
  setSyncStatus('off');
  toast('Sincronização desligada');
});

let syncTimer;
function scheduleSync() {
  if (!Sync.enabled()) return;
  clearTimeout(syncTimer);
  setSyncStatus('pending');
  syncTimer = setTimeout(syncNow, 3000);
}

// Cada gravação no Gist vira uma revisão — gravar à toa (várias telas abertas, a cada 2 min)
// aciona o limite anti-abuso do GitHub (erro 403). Por isso: só grava quando algo mudou,
// nunca duas sincronizações ao mesmo tempo e, se o GitHub pedir pausa, espera.
let sincronizando = false;
let sincronizarDeNovo = false;
let syncPausaAte = 0;

// Histórico dos Correios que o PC buscou na Ship24 (rastreios.json). updatedAt = atualizadoEm do PC,
// igual em todos os aparelhos: assim ninguém regrava o Gist só por ter aplicado a mesma coisa.
function aplicarRastreios(rastreios) {
  if (!rastreios || typeof rastreios !== 'object') return;
  let mudou = false;
  for (const p of visibleItems()) {
    const r = rastreios[p.code];
    if (!r?.events?.length || !r.atualizadoEm || (p.eventsAt || 0) >= r.atualizadoEm) continue;
    const novoEvento = r.events[0].text !== p.lastEvent?.text;
    p.events = r.events.slice(0, 60);
    p.lastEvent = { text: r.events[0].text, time: r.events[0].time };
    p.eventsAt = r.atualizadoEm;
    p.fonteEventos = 'correios';
    if (STATUS[r.status]) p.status = r.status;
    p.updatedAt = Math.max(p.updatedAt || 0, r.atualizadoEm);
    if (novoEvento) adicionarNotificacao('status', `${p.name || p.code}: ${r.events[0].text}`);
    mudou = true;
  }
  if (mudou) save({ sync: false });
}

function assinatura(items) {
  return JSON.stringify([...items].sort((a, b) => (a.id < b.id ? -1 : 1)));
}

async function syncNow() {
  if (!Sync.enabled()) return setSyncStatus('off');
  if (Date.now() < syncPausaAte) return setSyncStatus('pausa', syncPausaAte);
  if (sincronizando) { sincronizarDeNovo = true; return; }
  sincronizando = true;
  try {
    setSyncStatus('busy');
    const remoto = await Sync.pull();
    state.items = Sync.merge(state.items, remoto.items);
    save({ sync: false });
    // Busca concluída no PC: o server.py publica no Gist, então chega também ao celular
    importarUltimaBusca(remoto.busca);
    aplicarRastreios(remoto.rastreios);
    if (!TEM_SERVIDOR) atualizarInfoBusca(remoto.busca?.fimEm, remoto.andamento?.agenda);
    if (assinatura(state.items) !== assinatura(remoto.items)) await Sync.push(state.items);
    setSyncStatus('ok');
  } catch (err) {
    if (err.pausaAte) {
      syncPausaAte = err.pausaAte;
      setSyncStatus('pausa', syncPausaAte);
      setTimeout(syncNow, Math.max(5000, syncPausaAte - Date.now() + 2000));
    } else {
      setSyncStatus('error', err.message);
    }
  } finally {
    sincronizando = false;
    if (sincronizarDeNovo) { sincronizarDeNovo = false; scheduleSync(); }
  }
}

// Com a tela aberta, sincroniza a cada 2 min (uma busca pedida pelo celular é acompanhada à parte)
setInterval(() => { if (!document.hidden) syncNow(); }, 120000);

// O server.py (no PC) usa o mesmo Gist para publicar as buscas e receber pedidos do celular
async function enviarGistAoServidor(gist = Sync.enabled() ? Sync.config() : null) {
  if (!TEM_SERVIDOR) return;
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gist: gist && { token: gist.token, gistId: gist.gistId } }),
    });
  } catch { /* sem server.py (site publicado) */ }
}

// ---------- Última e próxima busca automática ----------
// Vem do server.py (PC: /api/busca/estado) ou do Gist (celular: busca.json + andamento.json).
// Guardada localmente para aparecer na hora ao abrir o app.
const INFO_BUSCA_KEY = 'rastreazera:infoBusca';

function atualizarInfoBusca(ultimaFimEm, agenda) {
  const atual = lerJSON(INFO_BUSCA_KEY, {}) || {};
  const nova = {
    ultimaFimEm: ultimaFimEm || atual.ultimaFimEm || null,
    agenda: agenda === undefined ? atual.agenda : agenda,
  };
  gravarJSON(INFO_BUSCA_KEY, nova);
  renderInfoBusca();
}

function diaHora(ts) {
  const d = new Date(ts);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const dia = new Date(ts); dia.setHours(0, 0, 0, 0);
  const diff = Math.round((dia - hoje) / 86400000);
  return diff === 0 ? `hoje ${hm}` : diff === -1 ? `ontem ${hm}` : diff === 1 ? `amanhã ${hm}`
    : `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

function renderInfoBusca() {
  const el = $('#infoBusca');
  const info = lerJSON(INFO_BUSCA_KEY, null);
  if (!info || (!info.ultimaFimEm && !info.agenda)) { el.hidden = true; return; }
  const partes = [];
  partes.push(info.ultimaFimEm
    ? `Última busca: ${diaHora(info.ultimaFimEm)} (${tempoRelativo(info.ultimaFimEm)})`
    : 'Nenhuma busca concluída ainda');
  const a = info.agenda;
  if (a) {
    if (!a.coletorOnline) partes.push('Próxima: quando o Chrome do PC abrir');
    else if (!a.ativo) partes.push('Busca automática parada (▶ Iniciar no Coletor)');
    else if (a.proxima) {
      const min = Math.round((a.proxima - Date.now()) / 60000);
      partes.push(min <= 0 ? 'Próxima: a qualquer momento' : `Próxima: ${diaHora(a.proxima).replace('hoje ', '')} (em ${min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`})`);
    }
  }
  el.textContent = `🕒 ${partes.join(' · ')}`;
  el.hidden = false;
}
setInterval(() => { if (!document.hidden) renderInfoBusca(); }, 60000);

// ---------- Notificações push (enviadas pelo server.py do PC) ----------
// O aparelho se inscreve (Push API) e guarda a inscrição em push.json no Gist; o PC envia a cada
// busca com novidades. "Enviar teste" marca testeEm na inscrição e o PC responde em até 1 min.
const PUSH_KEY = 'rastreazera:push'; // inscrição deste aparelho

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
  return `${tipo} (ativado em ${fmtDate(Date.now())})`;
}

function renderNotifAparelho() {
  const inscricao = lerJSON(PUSH_KEY, null);
  const ativo = Boolean(inscricao) && pushSuportado() && Notification.permission === 'granted';
  $('#notifStatusAparelho').textContent = !pushSuportado()
    ? '⚠️ Este navegador não suporta notificações. No iPhone, abra o Rastreazera pelo ícone da tela de início (iOS 16.4 ou mais novo).'
    : ativo ? '✅ Notificações ativas neste aparelho.'
      : Notification.permission === 'denied' ? '🚫 Notificações bloqueadas: libere nas configurações do celular/navegador.'
        : 'Notificações desligadas neste aparelho.';
  $('#btnAtivarPush').hidden = ativo || !pushSuportado();
  $('#btnTestarPush').hidden = !ativo;
  $('#btnDesativarPush').hidden = !ativo;
}

$('#btnAtivarPush').addEventListener('click', async () => {
  if (!Sync.enabled()) return toast('Ligue a sincronização primeiro (⚙️ → Ler QR do PC)');
  const permissao = await Notification.requestPermission();
  if (permissao !== 'granted') { renderNotifAparelho(); return toast('Sem permissão para notificar'); }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(RZ_CONFIG.pushChavePublica) });
    const { endpoint, keys } = sub.toJSON();
    const registro = { endpoint, keys, aparelho: descreverAparelho(), criadoEm: Date.now() };
    await Sync.atualizarInscricao(endpoint, registro);
    gravarJSON(PUSH_KEY, registro);
    toast('Notificações ativadas neste aparelho');
  } catch (err) {
    toast(`Não foi possível ativar: ${err.message}`);
  }
  renderNotifAparelho();
});

$('#btnTestarPush').addEventListener('click', async () => {
  const registro = lerJSON(PUSH_KEY, null);
  if (!registro) return renderNotifAparelho();
  try {
    await Sync.atualizarInscricao(registro.endpoint, { ...registro, testeEm: Date.now() });
    toast('Teste pedido ao PC — chega em até 1 min (com o PC ligado)');
  } catch (err) {
    toast(`Não foi possível pedir o teste: ${err.message}`);
  }
});

$('#btnDesativarPush').addEventListener('click', async () => {
  const registro = lerJSON(PUSH_KEY, null);
  try {
    const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
    await sub?.unsubscribe();
    if (registro) await Sync.atualizarInscricao(registro.endpoint, null);
  } catch { /* segue desligando localmente */ }
  gravarJSON(PUSH_KEY, null);
  renderNotifAparelho();
  toast('Notificações desativadas neste aparelho');
});

// ---------- Configurar o celular por QR code ----------
// O QR abre o site público com #config=<token e Gist>. O fragmento (#) não é enviado a nenhum servidor
// e é apagado do endereço assim que lido.
let qrScript;

function base64url(texto) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(texto))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deBase64url(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

$('#btnQrCelular').addEventListener('click', async () => {
  const caixa = $('#qrCelular');
  if (!caixa.hidden) { caixa.hidden = true; $('#qrCodigo').innerHTML = ''; return; }
  if (!Sync.enabled()) return toast('Ative a sincronização (token do GitHub) primeiro');
  if (!RZ_CONFIG.sitePublico) return toast('O site ainda não foi publicado (config.js → sitePublico)');
  const { token, gistId } = Sync.config();
  const url = `${RZ_CONFIG.sitePublico}#config=${base64url(JSON.stringify({ token, gistId }))}`;
  try {
    qrScript ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = resolve;
      s.onerror = () => { qrScript = null; reject(new Error('sem conexão')); };
      document.head.appendChild(s);
    });
    await qrScript;
  } catch {
    return toast('Não foi possível carregar o gerador de QR code');
  }
  $('#qrCodigo').innerHTML = '';
  new QRCode($('#qrCodigo'), { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
  caixa.hidden = false;
});
$('#dlgSettings').addEventListener('close', () => { $('#qrCelular').hidden = true; $('#qrCodigo').innerHTML = ''; });

// Aceita o link inteiro (https://…#config=…) ou só o trecho #config=…; devolve true se configurou
function aplicarLinkConfig(texto) {
  const match = String(texto || '').match(/#config=([\w-]+)/);
  if (!match) return false;
  try {
    const { token, gistId } = JSON.parse(deBase64url(match[1]));
    if (!token || !gistId) throw new Error();
    Sync.setConfig({ token, gistId });
    toast('Celular configurado — sincronizando…');
    return true;
  } catch {
    toast('Link de configuração inválido');
    return false;
  }
}

function importarConfigDoHash() {
  if (!location.hash.startsWith('#config=')) return;
  const hash = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  aplicarLinkConfig(hash);
}

async function configurarPorLink(texto) {
  if (!aplicarLinkConfig(texto)) return;
  dlgSettings.close();
  await syncNow();
}

$('#linkConfig').addEventListener('change', (e) => {
  configurarPorLink(e.target.value);
  e.target.value = '';
});

// Leitor de QR dentro do app: no iPhone, o app da tela de início não enxerga o que foi
// configurado no Safari — então o próprio app lê o QR do PC com a câmera.
let leitorStream = null;
let jsQrScript;

function pararLeitorQr() {
  leitorStream?.getTracks().forEach((t) => t.stop());
  leitorStream = null;
  $('#leitorQr').hidden = true;
}

$('#btnLerQr').addEventListener('click', async () => {
  const video = $('#videoQr');
  try {
    leitorStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return toast('Sem acesso à câmera — permita nas configurações do navegador ou cole o link abaixo');
  }
  video.srcObject = leitorStream;
  $('#leitorQr').hidden = false;
  await video.play().catch(() => {});

  // Leitor nativo (Chrome/Android) ou jsQR (Safari/iPhone)
  let ler;
  if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats?.())?.includes('qr_code')) {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    ler = async () => (await detector.detect(video))[0]?.rawValue;
  } else {
    try {
      jsQrScript ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
        s.onload = resolve;
        s.onerror = () => { jsQrScript = null; reject(new Error()); };
        document.head.appendChild(s);
      });
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
$('#btnPararQr').addEventListener('click', pararLeitorQr);
$('#dlgSettings').addEventListener('close', pararLeitorQr);

// ---------- Busca pedida pelo celular (sem server.py): o PC recebe pelo Gist ----------
// O PC publica cada etapa em andamento.json; o celular lê a cada 15 s e mostra o progresso.
const PEDIDO_REMOTO_KEY = 'rastreazera:pedidoRemoto';
const PEDIDO_REMOTO_MAX_MS = 25 * 60000;
const PC_SEM_RESPOSTA_MS = 150000; // o server.py confere pedidos a cada 1 min
const ACOMPANHAR_MS = 15000;
let acompanhamentoTimer = null;

async function pedirBuscaRemota() {
  if (!Sync.enabled()) return toast('Para buscar pelo celular, configure a sincronização em ⚙️ (QR code no PC)');
  let ts;
  try {
    ts = await Sync.pedirBusca();
  } catch (err) {
    return toast(`Não foi possível pedir a busca: ${err.message}`);
  }
  gravarJSON(PEDIDO_REMOTO_KEY, ts);
  renderAndamento(ts, null);
  acompanhamentoTimer = setTimeout(acompanharBuscaRemota, 3000);
}

function encerrarAcompanhamento() {
  clearTimeout(acompanhamentoTimer);
  gravarJSON(PEDIDO_REMOTO_KEY, null);
  $('#andamentoRemoto').hidden = true;
  $('#btnBuscar').disabled = false;
}

async function acompanharBuscaRemota() {
  clearTimeout(acompanhamentoTimer);
  const pedidoEm = Number(lerJSON(PEDIDO_REMOTO_KEY, 0)) || 0;
  if (!pedidoEm || !Sync.enabled()) return;
  if (document.hidden) return; // retoma ao voltar para a tela (visibilitychange)

  let remoto = null;
  let erroConexao = '';
  try { remoto = await Sync.pull(); } catch (err) { erroConexao = err.message; }

  // Concluída: a busca.json do PC é posterior ao pedido → importa e encerra (o 🔔 mostra o resumo)
  if (remoto?.busca?.fimEm > pedidoEm) {
    encerrarAcompanhamento();
    await syncNow();
    return;
  }
  const pedidoPc = remoto?.andamento?.pedido?.ts === pedidoEm ? remoto.andamento.pedido : null;
  if (pedidoPc?.erro) { // erro definitivo (ex.: nenhuma loja marcada): mostra e para de acompanhar
    renderAndamento(pedidoEm, remoto.andamento);
    clearTimeout(acompanhamentoTimer);
    gravarJSON(PEDIDO_REMOTO_KEY, null);
    $('#btnBuscar').disabled = false;
    return;
  }
  if (Date.now() - pedidoEm > PEDIDO_REMOTO_MAX_MS) {
    encerrarAcompanhamento();
    adicionarNotificacao('busca', 'A busca pedida pelo celular não terminou em 25 min (o PC precisa estar ligado, com o Chrome aberto).');
    return;
  }
  renderAndamento(pedidoEm, remoto?.andamento, erroConexao, Boolean(remoto && !remoto.andamento));
  acompanhamentoTimer = setTimeout(acompanharBuscaRemota, ACOMPANHAR_MS);
}

function hora(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Etapas: ✅ feita · ⏳ esperando · ⚠️ demorando · ❌ problema
// semSinalDoPc: o Gist deste aparelho nunca recebeu andamento.json (o PC usa outro Gist?)
function renderAndamento(pedidoEm, a, erroConexao = '', semSinalDoPc = false) {
  const passos = [];
  const passo = (tipo, texto, quando) => passos.push(
    `<li class="passo-${tipo}"><span class="passo-icone">${{ ok: '✅', espera: '⏳', aviso: '⚠️', erro: '❌' }[tipo]}</span>
       <span>${texto}${quando ? ` <time>${hora(quando)}</time>` : ''}</span></li>`);

  passo('ok', 'Pedido enviado ao PC', pedidoEm);
  const pedidoPc = a?.pedido?.ts === pedidoEm ? a.pedido : null;
  if (!pedidoPc) {
    if (semSinalDoPc) {
      passo('erro', 'Este aparelho está num Gist que o PC não usa. No PC, ⚙️ → Mostrar QR, e aqui ⚙️ → Ler QR do PC.');
    } else if (Date.now() - pedidoEm > PC_SEM_RESPOSTA_MS) {
      passo('aviso', 'O PC ainda não recebeu o pedido. Ele está ligado, com o servidor rodando? Continuo tentando…');
    } else {
      passo('espera', 'Aguardando o PC receber (ele confere a cada 1 min)…');
    }
  } else {
    passo('ok', 'PC recebeu o pedido', pedidoPc.recebidoEm);
    if (pedidoPc.erro) {
      passo('erro', esc(pedidoPc.erro));
    } else if (a.etapa === 'aguardando_coletor') {
      passo(a.erro ? 'erro' : 'espera', a.erro ? esc(a.erro) : 'Aguardando a extensão Rastreazera Coletor no Chrome (até 1 min)…');
    } else if (a.etapa === 'buscando') {
      passo('ok', 'Busca iniciada no Chrome', a.busca.inicio);
      for (const loja of ORDEM_FONTES.filter((l) => a.busca.esperadas.includes(l))) {
        const r = a.busca.fontes[loja];
        if (r?.erro) passo('erro', `${FONTES[loja]}: ${esc(r.erro)}`);
        else if (r) passo('ok', `${FONTES[loja]}: ${plural(r.pedidos, 'pedido encontrado', 'pedidos encontrados')}`);
        else if (loja !== 'olx') passo('espera', `${FONTES[loja]}: buscando…`);
        else if (!a.busca.olxPedida) passo('espera', 'OLX: começa depois das outras lojas');
        else if (!a.busca.olxIniciada) passo('espera', 'OLX: aguardando a extensão OLX Dashboard…');
        else {
          const contas = (a.busca.olxContas || [])
            .map((c) => `${esc(c.nome)} ${{ ok: '✅', verificando: '🔄', erro: '❌' }[c.status] || '⏳'}`).join(' ');
          passo('espera', `OLX: verificando as contas${contas ? ` — ${contas}` : '…'}`);
        }
      }
    } else {
      passo('espera', 'Finalizando…');
    }
  }
  if (erroConexao) passo('aviso', `Sem conexão com o GitHub agora (${esc(erroConexao)}). Tentando de novo…`);

  $('#andamentoLista').innerHTML = passos.join('');
  $('#andamentoRemoto').hidden = false;
  $('#btnBuscar').disabled = true;
}

$('#btnFecharAndamento').addEventListener('click', encerrarAcompanhamento);

function setSyncStatus(kind, detail = '') {
  const el = $('#syncStatus');
  const map = {
    off: ['', ''],
    pending: ['●', 'Alterações aguardando envio'],
    busy: ['⟳', 'Sincronizando…'],
    ok: ['☁️', 'Sincronizado'],
    error: ['⚠️', `Erro na sincronização${detail ? ': ' + detail : ''}`],
    pausa: ['⏸', `O GitHub pediu uma pausa (limite de uso) — sincronizo de novo às ${detail ? hora(detail).slice(0, 5) : 'instantes'}`],
  };
  const [icon, title] = map[kind];
  el.textContent = icon;
  el.title = title;
  el.dataset.kind = kind;
}
// No celular não há "passar o mouse": tocar no ícone mostra a mensagem e tenta de novo
$('#syncStatus').addEventListener('click', () => {
  const el = $('#syncStatus');
  if (el.title) toast(el.title);
  if (el.dataset.kind !== 'pausa') syncNow();
});

// ---------- Backup ----------
$('#btnExport').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.items, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rastreazera-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#fileImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw new Error('formato inválido');
    state.items = Sync.merge(state.items, data.filter((p) => p && p.id && (p.code || p.deleted)));
    save();
    toast(`Importado: ${data.length} item(ns)`);
  } catch (err) {
    toast(`Não foi possível importar: ${err.message}`);
  }
  e.target.value = '';
});

// ---------- Importação de pedidos (Shopee / AliExpress) ----------
// O coletor (coletor/coletores.js) roda dentro do site da loja e abre o Rastreazera com os pedidos em
// #importar=<json>. O fragmento (#) nunca é enviado a nenhum servidor.
// Reimportar também ATUALIZA os pacotes já cadastrados (último evento, histórico, status, previsão).
const FONTES = { shopee: 'Shopee', aliexpress: 'AliExpress', olx: 'OLX' };

function cleanEvent(ev) {
  if (!ev?.text || !Number(ev.time)) return null;
  return { text: String(ev.text).slice(0, 300), time: Number(ev.time), ...(ev.location ? { location: String(ev.location).slice(0, 120) } : {}) };
}

function importFromHash() {
  const match = location.hash.match(/^#importar=(.+)$/);
  if (!match) return;
  history.replaceState(null, '', location.pathname + location.search);

  let payload;
  try { payload = JSON.parse(decodeURIComponent(match[1])); } catch { return toast('Dados de importação inválidos'); }
  importarDados(payload);
}

// Cadastra/atualiza pedidos vindos de uma loja: { fonte, pedidos: [{ orderId, code, name, shop, account?,
// status, lastEvent?, events?, eta?, carrierName?, onlyUpdate? }] }. onlyUpdate: não cria, só atualiza.
function importarDados(payload) {
  if (!Array.isArray(payload?.pedidos)) return;
  const fonte = FONTES[payload.fonte] ? payload.fonte : 'shopee';

  let novos = 0, atualizados = 0, semCodigo = 0;
  for (const ped of payload.pedidos) {
    const code = normalizeCode(ped.code);
    if (!code) { if (!ped.onlyUpdate) semCodigo++; continue; }
    const ref = ped.orderId ? `${fonte}:${ped.orderId}` : '';
    const lastEvent = cleanEvent(ped.lastEvent);
    const events = Array.isArray(ped.events) ? ped.events.map(cleanEvent).filter(Boolean).slice(0, 60) : null;
    const eta = /^\d{4}-\d{2}-\d{2}$/.test(ped.eta || '') ? ped.eta : '';

    const existe = visibleItems().find((p) =>
      p.code === code || (ref && p.orderRef === ref) || (fonte === 'shopee' && ped.orderId && p.shopeeOrderId === ped.orderId));
    if (existe) {
      let mudou = false; // só mudanças que o usuário enxerga contam como "atualizado"
      if (ref && !existe.orderRef) { existe.orderRef = ref; existe.updatedAt = Date.now(); }
      if (eta && existe.eta !== eta) { existe.eta = eta; mudou = true; }
      if (lastEvent && lastEvent.time > (existe.lastEvent?.time || 0)) {
        existe.lastEvent = lastEvent;
        if (events?.length) { existe.events = events; existe.eventsAt = Date.now(); }
        if (STATUS[ped.status] && existe.status !== 'entregue') existe.status = ped.status;
        mudou = true;
      }
      // Lojas sem histórico de eventos (ex.: OLX) só informam que o pedido foi entregue
      if (ped.status === 'entregue' && existe.status !== 'entregue') { existe.status = 'entregue'; mudou = true; }
      if (mudou) { existe.updatedAt = Date.now(); atualizados++; }
      continue;
    }
    if (ped.onlyUpdate) continue;

    state.items.push({
      id: uid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      code,
      name: String(ped.name || '').slice(0, 120),
      store: FONTES[fonte],
      carrier: detectCarrier(code),
      status: STATUS[ped.status] ? ped.status : 'transito',
      eta,
      notes: [
        ped.shop && `Loja: ${String(ped.shop).slice(0, 80)}`,
        ped.account && `Conta: ${String(ped.account).slice(0, 60)}`,
        ped.carrierName && `Envio: ${String(ped.carrierName).slice(0, 60)}`,
      ]
        .filter(Boolean).join(' · '),
      orderRef: ref,
      lastEvent,
      ...(events?.length ? { events, eventsAt: Date.now() } : {}),
    });
    novos++;
  }
  save();
  const stats = {
    fonte,
    total: payload.pedidos.filter((p) => !p.onlyUpdate).length, // pedidos ativos encontrados na loja
    novos,
    atualizados,
    semCodigo,
    parado: Boolean(payload.parado),
  };
  registrarResultadoBusca(stats);
  return stats;
}

// ---------- Buscas e notificações (sininho) ----------
// Uma "busca" junta o resultado de várias lojas (ex.: o agente /importar-pedidos busca Shopee, AliExpress
// e OLX) e, quando todas terminam, gera UMA notificação: "3 pedidos Shopee (1 novo) · 2 pedidos ...".
// Importações avulsas (favorito, botão só da OLX) viram uma notificação só daquela loja.
const BUSCA_KEY = 'rastreazera:busca';
const NOTIF_KEY = 'rastreazera:notificacoes';
const BUSCA_MAX_MS = 45 * 60000; // busca que não terminou nesse tempo é fechada com o que tiver
const ORDEM_FONTES = ['shopee', 'aliexpress', 'olx'];

function lerJSON(key, padrao) {
  try { return JSON.parse(localStorage.getItem(key)) ?? padrao; } catch { return padrao; }
}
function gravarJSON(key, valor) {
  try {
    if (valor == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(valor));
  } catch { /* sem storage */ }
}

function buscaAtiva() {
  const b = lerJSON(BUSCA_KEY, null);
  if (b && Date.now() - b.inicio > BUSCA_MAX_MS) { finalizarBusca(); return null; }
  return b;
}

// fontes: lojas que esta busca vai consultar. Se já houver uma busca em andamento, soma a ela.
function iniciarBusca(fontes) {
  const b = buscaAtiva() || { inicio: Date.now(), esperadas: [], resultados: {} };
  b.esperadas = [...new Set([...b.esperadas, ...fontes])];
  gravarJSON(BUSCA_KEY, b);
}

function registrarResultadoBusca(stats) {
  const b = buscaAtiva();
  if (!b) {
    notificarBusca({ [stats.fonte]: stats });
    return;
  }
  b.resultados[stats.fonte] = stats;
  if (!b.esperadas.includes(stats.fonte)) b.esperadas.push(stats.fonte);
  gravarJSON(BUSCA_KEY, b);
  if (b.esperadas.every((f) => b.resultados[f])) finalizarBusca();
  else toast(`${textoFonte(stats) || `${FONTES[stats.fonte]}: sem novidades`} — aguardando ${b.esperadas.filter((f) => !b.resultados[f]).map((f) => FONTES[f]).join(', ')}`);
}

function registrarFalhaBusca(fonte, motivo) {
  registrarResultadoBusca({ fonte, erro: motivo });
}

function finalizarBusca() {
  const b = lerJSON(BUSCA_KEY, null);
  gravarJSON(BUSCA_KEY, null);
  if (!b) return;
  for (const f of b.esperadas) b.resultados[f] ??= { fonte: f, erro: 'não terminou' };
  if (Object.keys(b.resultados).length) notificarBusca(b.resultados);
}

function plural(n, singular, pluralTxt) {
  return `${n} ${n === 1 ? singular : pluralTxt}`;
}

// Texto de uma loja no resumo: só aparece com novidade ("Shopee: 1 novo, 2 atualizados") ou
// problema ("OLX: extensão não respondeu"). Sem nada a contar, devolve null.
function textoFonte(s) {
  const loja = FONTES[s.fonte] || s.fonte;
  if (s.erro) return `${loja}: ${s.erro}`;
  const detalhes = [
    s.novos && plural(s.novos, 'novo', 'novos'),
    s.atualizados && plural(s.atualizados, 'atualizado', 'atualizados'),
  ].filter(Boolean);
  if (s.parado) detalhes.push('verificação interrompida');
  return detalhes.length ? `${loja}: ${detalhes.join(', ')}` : null;
}

function resumoBusca(resultados) {
  const ordenados = Object.values(resultados)
    .sort((a, b) => ORDEM_FONTES.indexOf(a.fonte) - ORDEM_FONTES.indexOf(b.fonte));
  const novidades = ordenados.filter((s) => !s.erro).map(textoFonte).filter(Boolean);
  const problemas = ordenados.filter((s) => s.erro).map(textoFonte);
  return [...(novidades.length ? novidades : ['Sem atualizações']), ...problemas].join(' · ');
}

function notificarBusca(resultados) {
  const texto = resumoBusca(resultados);
  adicionarNotificacao('busca', texto);
  toast(texto);
}

function adicionarNotificacao(tipo, texto) {
  const lista = lerJSON(NOTIF_KEY, []);
  lista.unshift({ id: uid(), ts: Date.now(), tipo, texto, lida: false });
  gravarJSON(NOTIF_KEY, lista.slice(0, 100));
  renderNotificacoes();
}

const NOTIF_ICONE = { busca: '🔎', status: '📦' };

function renderNotificacoes() {
  const lista = lerJSON(NOTIF_KEY, []);
  const naoLidas = lista.filter((n) => !n.lida).length;
  const badge = $('#notifBadge');
  badge.textContent = naoLidas > 9 ? '9+' : naoLidas;
  badge.hidden = !naoLidas;
  $('#btnNotif').title = naoLidas ? `${naoLidas} notificação(ões) nova(s)` : 'Notificações';
  $('#notifList').innerHTML = lista.length
    ? lista.map((n) => `
        <li class="${n.lida ? '' : 'nova'}">
          <span class="notif-icone">${NOTIF_ICONE[n.tipo] || '🔔'}</span>
          <div><p>${esc(n.texto)}</p><time>${fmtDateTime(n.ts)}</time></div>
        </li>`).join('')
    : '<li class="vazia">Nenhuma notificação.</li>';
}

function marcarNotificacoesLidas() {
  const lista = lerJSON(NOTIF_KEY, []);
  if (!lista.some((n) => !n.lida)) return;
  gravarJSON(NOTIF_KEY, lista.map((n) => ({ ...n, lida: true })));
}

$('#btnNotif').addEventListener('click', (e) => {
  e.stopPropagation();
  const painel = $('#notifPanel');
  if (!painel.hidden) { painel.hidden = true; renderNotificacoes(); return; }
  renderNotificacoes(); // mostra as novas destacadas…
  painel.hidden = false;
  marcarNotificacoesLidas(); // …e já conta como lidas (o destaque some ao fechar)
  $('#notifBadge').hidden = true;
});
$('#btnNotifLimpar').addEventListener('click', (e) => {
  e.stopPropagation();
  gravarJSON(NOTIF_KEY, []);
  renderNotificacoes();
});
document.addEventListener('click', (e) => {
  const painel = $('#notifPanel');
  if (!painel.hidden && !e.target.closest('#notifPanel')) { painel.hidden = true; renderNotificacoes(); }
});

// Usado pelo agente /importar-pedidos para agrupar as lojas numa busca só
window.Rastreazera = { iniciarBusca, registrarFalhaBusca, finalizarBusca };

// ---------- Busca automática (extensão Rastreazera Coletor + OLX Dashboard, via server.py) ----------
// A extensão Rastreazera Coletor (pasta coletor/, no Chrome) busca Shopee e AliExpress a cada 1 hora e
// o server.py pede a Verificação Completa da OLX; quando todas as lojas respondem, a busca fica em
// /api/busca/estado → "ultima" e é importada aqui (uma notificação no 🔔). Buscas que terminaram com o
// site fechado são importadas ao abrir. O botão "Buscar pedidos" pede uma busca na hora.
const BUSCA_API = '/api/busca';
// server.py só existe no PC (localhost); no site publicado tudo passa pelo Gist
const TEM_SERVIDOR = ['localhost', '127.0.0.1'].includes(location.hostname);
const BUSCA_VISTA_KEY = 'rastreazera:buscaVista';
const CHECAR_BUSCA_MS = 60000; // sem busca em andamento
const CHECAR_BUSCA_RAPIDO_MS = 4000; // durante uma busca
let buscaTimer = null;
let buscaSolicitadaEm = 0;
let servidorConfigurado = false; // já conferiu se o server.py sabe qual é o Gist

function olxStatus(pedido) {
  return { transito: 'transito', preparacao: 'aguardando', entregue: 'entregue', cancelamento: 'problema' }[pedido.statusTipo] || 'transito';
}

function olxParaImportacao(resultado) {
  return {
    fonte: 'olx',
    parado: resultado.parado,
    pedidos: (resultado.pedidos || [])
      .filter((p) => p.statusTipo !== 'cancelamento')
      .map((p) => ({
        orderId: String(p.link || '').split('/').pop() || '',
        code: p.codigoRastreio || '',
        name: p.titulo || 'Pedido OLX',
        account: p.conta || '',
        status: olxStatus(p),
        // Entregues só atualizam pacotes que já estão aqui — não enchem a lista de pedidos antigos
        onlyUpdate: p.statusTipo === 'entregue',
      })),
  };
}

// Importa a última busca concluída, se ainda não foi importada neste navegador
function importarUltimaBusca(ultima) {
  if (!ultima?.fimEm || ultima.fimEm <= (Number(lerJSON(BUSCA_VISTA_KEY, 0)) || 0)) return;
  gravarJSON(BUSCA_VISTA_KEY, ultima.fimEm);
  const lojas = ORDEM_FONTES.filter((f) => ultima.esperadas.includes(f));
  if (!lojas.length) return; // todas as lojas foram desmarcadas durante a busca
  iniciarBusca(lojas); // agrupa as lojas numa notificação só
  for (const loja of lojas) {
    const r = ultima.fontes[loja] || { erro: 'sem resposta' };
    if (r.erro) registrarFalhaBusca(loja, r.erro);
    else if (loja === 'olx') importarDados(olxParaImportacao(r));
    else importarDados({ fonte: loja, pedidos: r.pedidos });
  }
  refreshAll();
}

function mostrarProgressoBusca(estado) {
  const el = $('#olxStatus');
  const atual = estado?.atual;
  if (atual) {
    const icone = (loja) => {
      const r = atual.fontes[loja];
      return r ? (r.erro ? '❌' : '✅') : '🔄';
    };
    const lojas = atual.esperadas.map((l) => `${FONTES[l]} ${icone(l)}`).join(' · ');
    const contas = estado.olxProgresso?.contas;
    const sufixo = !atual.fontes.olx && contas?.length
      ? ` (${contas.map((c) => `${c.nome} ${{ ok: '✅', verificando: '🔄', erro: '❌' }[c.status] || '⏳'}`).join(' ')})`
      : '';
    el.textContent = `Buscando pedidos: ${lojas}${sufixo}`;
  } else if (estado?.solicitadoEm) {
    el.textContent = 'Busca solicitada — aguardando a extensão Rastreazera Coletor no Chrome…';
  } else {
    el.textContent = '';
  }
  el.hidden = !el.textContent;
  $('#btnBuscar').disabled = Boolean(atual || estado?.solicitadoEm);
}

async function checarBusca() {
  clearTimeout(buscaTimer);
  if (!TEM_SERVIDOR) return; // site publicado: as buscas chegam pelo Gist (syncNow)
  let estado = null;
  try {
    const res = await fetch(`${BUSCA_API}/estado`, { cache: 'no-store' });
    if (res.ok) estado = await res.json();
  } catch { /* sem server.py (ex.: site publicado sem proxy local) */ }
  if (!estado) {
    $('#btnBuscar').disabled = false;
    return;
  }
  if (!servidorConfigurado) {
    servidorConfigurado = true;
    const cfg = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
    if (cfg && !cfg.gistConfigurado && Sync.enabled()) enviarGistAoServidor();
    if (cfg) { mostrarChaveCorreios(cfg.rastreioConfigurado); refreshAll(); }
  }
  mostrarProgressoBusca(estado);
  importarUltimaBusca(estado.ultima);
  atualizarInfoBusca(estado.ultima?.fimEm, estado.agenda);

  // O Coletor confere pedidos a cada 1 min: sem resposta em 2,5 min, ele não está rodando
  if (buscaSolicitadaEm && estado.solicitadoEm && Date.now() - buscaSolicitadaEm > 150000) {
    buscaSolicitadaEm = 0;
    adicionarNotificacao('busca', 'Busca não começou: abra o Chrome com a extensão Rastreazera Coletor (a busca fica pendente e roda quando ela abrir)');
    toast('A extensão Rastreazera Coletor não respondeu');
  }
  if (!estado.atual && !estado.solicitadoEm) buscaSolicitadaEm = 0;
  const emAndamento = estado.atual || estado.solicitadoEm;
  buscaTimer = setTimeout(checarBusca, emAndamento ? CHECAR_BUSCA_RAPIDO_MS : CHECAR_BUSCA_MS);
}

async function buscarAgora() {
  let lojas = null;
  if (TEM_SERVIDOR) try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) lojas = (await res.json()).lojas;
  } catch { /* sem server.py */ }
  // Sem server.py (celular, site publicado): o pedido vai ao PC pelo Gist
  if (!lojas) return pedirBuscaRemota();
  if (!Object.values(lojas).some(Boolean)) return toast('Nenhum local marcado em ⚙️ → Onde buscar pedidos');
  try {
    const res = await fetch(`${BUSCA_API}/solicitar`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) throw new Error();
  } catch {
    return toast('A busca de pedidos só funciona com o server.py rodando');
  }
  buscaSolicitadaEm = Date.now();
  toast('Busca de pedidos solicitada');
  checarBusca();
}

$('#btnBuscar').addEventListener('click', buscarAgora);

// Gera o favorito "Importar pedidos" (Shopee e AliExpress) apontando para este Rastreazera
async function buildBookmarklet() {
  const link = $('#bookmarklet');
  try {
    const src = await (await fetch('coletor/coletores.js')).text();
    const target = location.origin + location.pathname;
    const runner = `
      const w = window.open('about:blank', '_blank');
      try {
        const dados = await coletarPedidos();
        const url = ${JSON.stringify(target)} + '#importar=' + encodeURIComponent(JSON.stringify(dados));
        if (w) w.location.href = url; else location.href = url;
      } catch (e) { if (w) w.close(); alert('Rastreazera: ' + e.message); }`;
    link.href = 'javascript:' + encodeURIComponent(`(async()=>{${src}\n${runner}})()`);
  } catch {
    link.removeAttribute('href');
  }
}

// ---------- Utilidades ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ---------- Inicialização ----------
fillSelects();
render();
renderNotificacoes();
renderInfoBusca();
importarConfigDoHash();
importFromHash();
buildBookmarklet();
window.addEventListener('hashchange', () => { importFromHash(); refreshAll(); });
syncNow().then(refreshAll);
// Buscas automáticas que terminaram enquanto o site estava fechado + acompanhamento (só com o server.py)
checarBusca();
// Ao voltar para a aba (ex.: no celular), puxa as novidades do outro aparelho e das transportadoras
document.addEventListener('visibilitychange', () => { if (!document.hidden) { syncNow().then(refreshAll); checarBusca(); acompanharBuscaRemota(); } });
// Busca pedida pelo celular ainda em andamento (app foi fechado e reaberto)
acompanharBuscaRemota();

// Modo offline + atualização automática: ao voltar para o app (no celular ele costuma ser retomado
// da memória, sem recarregar), confere se há versão nova; quando ela assume, recarrega uma vez.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const jaTinhaControle = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('sw.js').then((reg) => {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
  let recarregou = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!jaTinhaControle || recarregou) return; // primeira instalação: a página já está atualizada
    recarregou = true;
    location.reload();
  });
}
$('#versaoApp').textContent = `Rastreazera · versão ${RZ_VERSAO}`;

// Zoom da página bloqueado no celular (pinça e dois toques não ampliam sem querer):
// - iPhone/Safari ignora o user-scalable=no e manda eventos "gesture*" na pinça;
// - fallback: dois dedos se mexendo não fazem nada (exceto nas fotos em tela cheia).
for (const tipo of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(tipo, (e) => { if (!e.target.closest?.('#galeria')) e.preventDefault(); }, { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1 && !e.target.closest?.('#galeria')) e.preventDefault();
}, { passive: false });
