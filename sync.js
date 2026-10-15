// Sincronização opcional usando um Gist secreto do GitHub como armazenamento.
// A API do GitHub aceita chamadas direto do navegador (CORS), então funciona no GitHub Pages.
//
// Arquivos no Gist:
//   rastreazera.json      pacotes (cada aparelho une com os seus e envia de volta)
//   busca.json            última busca de pedidos concluída no PC (gravado pelo server.py)
//   pedido_busca.json     { ts }: o celular pediu uma busca; o server.py do PC confere a cada minuto
//   andamento.json        etapa da busca no PC (gravado pelo server.py) — o celular mostra o progresso
//   push.json             aparelhos inscritos para notificações (o server.py do PC envia)
//   config.json           { lojas, ts }: 'Onde buscar pedidos' alterado no celular (o PC aplica)
//   rastreios.json        { codigo: { status, events, atualizadoEm } }: Correios pelo 17TRACK (gravado pelo server.py)
const Sync = (() => {
  const CFG_KEY = 'rastreazera:sync';
  const FILE = 'rastreazera.json';
  const FILE_BUSCA = 'busca.json';
  const FILE_PEDIDO = 'pedido_busca.json';
  const FILE_ANDAMENTO = 'andamento.json';
  const FILE_PUSH = 'push.json';
  const FILE_CONFIG = 'config.json';
  const FILE_RASTREIOS = 'rastreios.json';
  const API = 'https://api.github.com/gists';

  function config() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; }
  }
  function setConfig(cfg) {
    if (cfg) localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CFG_KEY);
  }
  function enabled() {
    const c = config();
    return Boolean(c.token && c.gistId);
  }

  async function request(url, { token, method = 'GET', body } = {}) {
    const res = await fetch(url, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      // 403/429 com limite: o GitHub pediu uma pausa (anti-abuso ou cota) — informa até quando
      const restante = res.headers.get('x-ratelimit-remaining');
      const retry = Number(res.headers.get('retry-after'));
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      if (res.status === 429 || (res.status === 403 && (retry || restante === '0'))) {
        const ate = retry ? Date.now() + retry * 1000 : reset ? reset * 1000 : Date.now() + 60000;
        throw Object.assign(new Error('GitHub pediu uma pausa'), { pausaAte: ate });
      }
      const msg = res.status === 401 ? 'token inválido' : res.status === 404 ? 'Gist não encontrado'
        : res.status === 403 ? 'acesso negado pelo GitHub (403) — o token ainda tem a permissão gist?' : `erro ${res.status}`;
      throw new Error(msg);
    }
    return res.json();
  }

  // Gist do Rastreazera que já existe na conta (evita criar um segundo ao colar só o token).
  // Prefere o que o PC usa (tem busca.json); senão, o atualizado mais recentemente.
  async function encontrarExistente(token) {
    const lista = await request(`${API}?per_page=100`, { token });
    const nossos = lista.filter((g) => g.files?.[FILE] && /rastreazera/i.test(g.description || ''));
    nossos.sort((a, b) => Boolean(b.files[FILE_BUSCA]) - Boolean(a.files[FILE_BUSCA])
      || new Date(b.updated_at) - new Date(a.updated_at));
    return nossos[0]?.id || null;
  }

  async function create(token, items) {
    const gist = await request(API, {
      token,
      method: 'POST',
      body: {
        description: 'Rastreazera – dados de rastreio',
        public: false,
        files: { [FILE]: { content: JSON.stringify(items, null, 1) } },
      },
    });
    return gist.id;
  }

  async function lerArquivo(gist, nome, padrao) {
    const file = gist.files && gist.files[nome];
    if (!file) return padrao;
    let content = file.content;
    if (file.truncated) content = await (await fetch(file.raw_url)).text();
    try { return JSON.parse(content || 'null') ?? padrao; } catch { return padrao; }
  }

  // { items, busca, pedido, andamento } — os três últimos são null quando não existem
  async function pull() {
    const { token, gistId } = config();
    const gist = await request(`${API}/${gistId}`, { token });
    const items = await lerArquivo(gist, FILE, []);
    return {
      items: Array.isArray(items) ? items : [],
      busca: await lerArquivo(gist, FILE_BUSCA, null),
      pedido: await lerArquivo(gist, FILE_PEDIDO, null),
      andamento: await lerArquivo(gist, FILE_ANDAMENTO, null),
      config: await lerArquivo(gist, FILE_CONFIG, null),
      rastreios: await lerArquivo(gist, FILE_RASTREIOS, null),
    };
  }

  async function push(items) {
    const { token, gistId } = config();
    await request(`${API}/${gistId}`, {
      token,
      method: 'PATCH',
      body: { files: { [FILE]: { content: JSON.stringify(items, null, 1) } } },
    });
  }

  // Celular (sem server.py): pede ao PC uma busca de pedidos. Devolve o ts do pedido
  // (o andamento.json do PC repete esse ts quando recebe).
  async function pedirBusca() {
    const { token, gistId } = config();
    const ts = Date.now();
    await request(`${API}/${gistId}`, {
      token,
      method: 'PATCH',
      body: { files: { [FILE_PEDIDO]: { content: JSON.stringify({ ts }) } } },
    });
    return ts;
  }

  // Celular (sem server.py): grava "Onde buscar pedidos"; o PC aplica em até 1 min
  async function salvarConfigLojas(lojas) {
    const { token, gistId } = config();
    await request(`${API}/${gistId}`, {
      token,
      method: 'PATCH',
      body: { files: { [FILE_CONFIG]: { content: JSON.stringify({ lojas, ts: Date.now() }) } } },
    });
  }

  // Aparelhos que recebem notificações (push.json): o server.py do PC envia para cada um.
  // novo = null remove o aparelho.
  async function atualizarInscricao(endpoint, novo, arquivo = FILE_PUSH) {
    const { token, gistId } = config();
    const gist = await request(`${API}/${gistId}`, { token });
    const lista = (await lerArquivo(gist, arquivo, [])).filter((r) => r && r.endpoint !== endpoint);
    if (novo) lista.push(novo);
    await request(`${API}/${gistId}`, {
      token,
      method: 'PATCH',
      body: { files: { [arquivo]: { content: JSON.stringify(lista, null, 1) } } },
    });
  }


  // Une duas listas: para cada id, fica a versão com updatedAt mais recente.
  function merge(a, b) {
    const map = new Map();
    for (const item of [...a, ...b]) {
      const cur = map.get(item.id);
      if (!cur || (item.updatedAt || 0) > (cur.updatedAt || 0)) map.set(item.id, item);
    }
    return [...map.values()];
  }

  return { config, setConfig, enabled, encontrarExistente, create, pull, push, pedirBusca, salvarConfigLojas, atualizarInscricao, merge };
})();
