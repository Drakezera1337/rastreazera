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

  const BY_CARRIER = { shopee: spx };

  return {
    proxyUrl,
    setProxyUrl,
    // Sem proxy (ex.: celular antes de configurar o Worker) não há consulta automática
    supports: (carrier) => carrier in BY_CARRIER && Boolean(proxyUrl()),
    fetch: (p) => BY_CARRIER[p.carrier](p.code),
  };
})();
