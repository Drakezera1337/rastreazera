// Sincronização opcional usando um Gist secreto do GitHub como armazenamento.
// A API do GitHub aceita chamadas direto do navegador (CORS), então funciona no GitHub Pages.
//
// Arquivos no Gist:
//   rastreazera.json      pacotes (cada aparelho une com os seus e envia de volta)
//   busca.json            última busca de pedidos concluída no PC (gravado pelo server.py)
//   pedido_busca.json     { ts }: o celular pediu uma busca; o server.py do PC confere a cada minuto
const Sync = (() => {
  const CFG_KEY = 'rastreazera:sync';
  const FILE = 'rastreazera.json';
  const FILE_BUSCA = 'busca.json';
  const FILE_PEDIDO = 'pedido_busca.json';
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
      const msg = res.status === 401 ? 'token inválido' : res.status === 404 ? 'Gist não encontrado' : `erro ${res.status}`;
      throw new Error(msg);
    }
    return res.json();
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

  // { items, busca, pedido } — busca/pedido são null quando não existem
  async function pull() {
    const { token, gistId } = config();
    const gist = await request(`${API}/${gistId}`, { token });
    const items = await lerArquivo(gist, FILE, []);
    return {
      items: Array.isArray(items) ? items : [],
      busca: await lerArquivo(gist, FILE_BUSCA, null),
      pedido: await lerArquivo(gist, FILE_PEDIDO, null),
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

  // Celular (sem server.py): pede ao PC uma busca de pedidos
  async function pedirBusca() {
    const { token, gistId } = config();
    await request(`${API}/${gistId}`, {
      token,
      method: 'PATCH',
      body: { files: { [FILE_PEDIDO]: { content: JSON.stringify({ ts: Date.now() }) } } },
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

  return { config, setConfig, enabled, create, pull, push, pedirBusca, merge };
})();
