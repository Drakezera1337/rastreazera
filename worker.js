// Cloudflare Worker: repassa consultas de rastreio para o Rastreazera publicado no GitHub Pages.
// Faz o mesmo que as rotas /api/* do server.py. Veja o passo a passo no README.
//
// Exemplo: https://SEU-WORKER.workers.dev/spx?tn=BR123456789012X

const UPSTREAMS = {
  spx: (tn) => `https://spx.com.br/shipment/order/open/order/get_order_info?spx_tn=${tn}&language_code=pt`,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const service = url.pathname.replace(/^\/+/, '');
    const tn = (url.searchParams.get('tn') || '').trim().toUpperCase();

    if (!UPSTREAMS[service] || !/^[A-Z0-9]{8,30}$/.test(tn)) {
      return new Response(JSON.stringify({ error: 'requisição inválida' }), { status: 400, headers: CORS });
    }

    try {
      const res = await fetch(UPSTREAMS[service](tn), {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      });
      return new Response(await res.text(), { status: res.status, headers: CORS });
    } catch (err) {
      return new Response(JSON.stringify({ error: `falha ao consultar a transportadora: ${err.message}` }), { status: 502, headers: CORS });
    }
  },
};
