// Consulta automática de rastreio, via proxy (server.py localmente, worker.js em produção).
// Cada rastreador devolve { events: [{ time, text, location }], status } com o evento mais recente primeiro.
const Trackers = (() => {
  const PROXY_KEY = 'rastreazera:proxy';

  function proxyUrl() {
    const saved = localStorage.getItem(PROXY_KEY);
    if (saved) return saved.replace(/\/+$/, '');
    // Rodando pelo server.py, o próprio servidor faz o repasse
    if (['localhost', '127.0.0.1'].includes(location.hostname)) return `${location.origin}/api`;
    // Site publicado (ex.: no celular): o Cloudflare Worker configurado em config.js
    return (typeof RZ_CONFIG !== 'undefined' && RZ_CONFIG.proxyPadrao || '').replace(/\/+$/, '');
  }
  function setProxyUrl(url) {
    if (url) localStorage.setItem(PROXY_KEY, url.trim());
    else localStorage.removeItem(PROXY_KEY);
  }

  async function callProxy(service, code) {
    const base = proxyUrl();
    if (!base) throw new Error('configure o endereço do proxy em ⚙️');
    const res = await fetch(`${base}/${service}?tn=${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error(`proxy respondeu ${res.status}`);
    return res.json();
  }

  // ---- Shopee Xpress (SPX Brasil) ----
  function spxStatus(record) {
    if (!record) return 'aguardando';
    const name = `${record.milestone_name} ${record.tracking_name}`.toLowerCase();
    if (/delivered|entregue/.test(name) && !/fail|unsuccess/.test(name)) return 'entregue';
    if (/out for delivery|saiu para entrega/.test(name)) return 'saiu';
    if (/return|cancel|lost|damage|devolu/.test(name)) return 'problema';
    if (record.milestone_code <= 1) return 'aguardando';
    return 'transito';
  }

  async function spx(code) {
    const json = await callProxy('spx', code);
    if (json.retcode !== 0) throw new Error(json.message || 'código não encontrado na SPX');
    const records = json.data?.sls_tracking_info?.records || [];
    // display_flag_v2 = 0 são eventos internos que o site oficial também esconde
    const visible = records.filter((r) => r.display_flag_v2 !== 0);
    return {
      status: spxStatus(visible[0]),
      events: visible.map((r) => ({
        time: r.actual_time * 1000,
        text: r.buyer_description || r.description,
        location: r.current_location?.location_name || '',
      })),
    };
  }

  // ---- Correios (API da Ship24 pelo server.py do PC; a chave só existe lá) ----
  // O server.py já devolve no formato do app; um código recém-cadastrado vem { pendente }.
  let correiosAtivo = false; // o app liga quando o server.py diz que a chave está configurada
  const local = () => ['localhost', '127.0.0.1'].includes(location.hostname);

  async function correios(code) {
    const res = await fetch(`${location.origin}/api/correios?tn=${encodeURIComponent(code)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Ship24 respondeu ${res.status}`);
    if (json.erro) throw new Error(json.erro);
    return json.pendente ? { pendente: true, events: [] } : json;
  }

  const CORREIOS = ['correios', 'postal_intl'];

  function suportado(p) {
    if (p.carrier === 'shopee') return Boolean(proxyUrl());
    // Correios: só no PC, com chave, e não para pedidos do AliExpress (já trazem o histórico
    // da importação — consultar gastaria cota da Ship24 à toa)
    return CORREIOS.includes(p.carrier) && correiosAtivo && local() && !String(p.orderRef || '').startsWith('aliexpress:');
  }

  return {
    proxyUrl,
    setProxyUrl,
    setCorreiosAtivo: (ativo) => { correiosAtivo = Boolean(ativo); },
    supports: suportado,
    fetch: (p) => (p.carrier === 'shopee' ? spx(p.code) : correios(p.code)),
  };
})();
