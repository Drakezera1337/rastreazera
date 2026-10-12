// Coletores de pedidos. Rodam DENTRO do site da loja, com a conta já logada:
// pelo favorito "Importar pedidos" (gerado em ⚙️ no Rastreazera) ou pelo agente /importar-pedidos.
// Só leem dados — nunca confirmam entrega, cancelam, avaliam ou alteram a conta.
// Cada coletor devolve { fonte, pedidos: [{ orderId, code, name, shop, status, lastEvent, events?, eta?, carrierName? }] }.

function statusDoEvento(texto) {
  const t = String(texto || '').toLowerCase();
  if (/saiu para entrega|out for delivery/.test(t)) return 'saiu';
  if (/entregue|delivered/.test(t) && !/não|nao|falha|tentativa/.test(t)) return 'entregue';
  if (/taxa|tribut|pagamento.*(import|imposto)|aguardando pagamento/.test(t)) return 'fiscalizacao';
  if (/devolv|extravi|retid|problema|falha|tentativa/.test(t)) return 'problema';
  return 'transito';
}

// ---------- Shopee (shopee.com.br) ----------
async function coletarPedidosShopee() {
  async function api(path) {
    const res = await fetch(path, { credentials: 'include' });
    const json = await res.json();
    if (json.error) throw new Error(`a Shopee respondeu erro ${json.error} — verifique se está logado`);
    return json;
  }

  const ENCERRADO = /completed|cancel|to_pay|unpaid|refund|return/;
  const ativos = [];
  // A lista vem do pedido mais recente para o mais antigo: para quando uma página não tiver nenhum ativo
  for (let offset = 0; offset < 100; offset += 20) {
    const json = await api(`/api/v4/order/get_all_order_and_checkout_list?limit=20&offset=${offset}`);
    const page = (json.new_data?.order_or_checkout_data || []).map((o) => o.order_list_detail).filter(Boolean);
    const pageAtivos = page.filter((d) => !ENCERRADO.test(d.status?.status_label?.text || ''));
    ativos.push(...pageAtivos);
    if (page.length < 20 || !pageAtivos.length) break;
  }

  const pedidos = [];
  for (const d of ativos) {
    const card = d.info_card.order_list_cards[0];
    const items = card.product_info.item_groups.flatMap((g) => g.items);
    const detalhe = (await api(`/api/v4/order/get_order_detail?order_id=${d.info_card.order_id}`)).data;
    const evento = d.shipping?.tracking_info;
    const label = d.status?.status_label?.text || '';
    pedidos.push({
      orderId: String(d.info_card.order_id),
      code: detalhe?.shipping?.tracking_number || '',
      name: (items[0]?.name || 'Pedido Shopee') + (items.length > 1 ? ` (+${items.length - 1})` : ''),
      shop: card.shop_info?.shop_name || '',
      status: /on_the_way|to_receive|shipping/.test(label) ? 'transito' : 'aguardando',
      lastEvent: evento?.description ? { text: evento.description, time: evento.ctime * 1000 } : null,
    });
  }
  return { fonte: 'shopee', pedidos };
}

// ---------- AliExpress (aliexpress.com) ----------
// Usa o cliente "mtop" que as próprias páginas do AliExpress carregam (assina as requisições com a sessão).
async function coletarPedidosAliExpress() {
  // A página carrega o mtop depois de alguns segundos (importa quando a aba acabou de abrir)
  for (let i = 0; i < 30 && !window.lib?.mtop?.request; i++) await new Promise((r) => setTimeout(r, 500));
  const mtop = window.lib?.mtop;
  if (!mtop?.request) throw new Error('abra a página de pedidos do AliExpress (logado) e tente de novo');

  async function call(api, data) {
    const res = await mtop.request({ api, v: '1.0', method: 'GET', type: 'GET', dataType: 'originaljsonp', timeout: 15000, data });
    if (!String(res.ret?.[0]).startsWith('SUCCESS')) throw new Error(`o AliExpress respondeu "${res.ret?.[0]}" — verifique se está logado`);
    return res.data;
  }

  const base = { clientPlatform: 'pc', shipToCountry: 'BR', _lang: 'pt_BR', timeZone: 'GMT-0300' };
  const ordens = new Map();
  for (const statusTab of ['processing', 'shipped']) {
    for (let page = 1; page <= 10; page++) {
      const d = (await call('mtop.aliexpress.trade.buyer.order.list', {
        ...base, statusTab, renderType: page === 1 ? 'init' : 'loadMore', pageIndex: page,
      })).data || {};
      const novas = Object.keys(d)
        .filter((k) => k.startsWith('pc_om_list_order_'))
        .map((k) => d[k].fields)
        .filter((f) => f?.orderId && !ordens.has(f.orderId));
      novas.forEach((f) => ordens.set(f.orderId, f));
      const body = Object.keys(d).find((k) => k.startsWith('pc_om_list_body'));
      if (!novas.length || !d[body]?.fields?.hasMore) break;
    }
  }

  const pedidos = [];
  for (const o of ordens.values()) {
    const nome = (o.orderLines?.[0]?.itemTitle || 'Pedido AliExpress') +
      (o.orderLines?.length > 1 ? ` (+${o.orderLines.length - 1})` : '');
    const m = (await call('mtop.ae.ld.querydetail', {
      tradeOrderId: o.orderId, tradeOrderLineId: '', terminalType: 'PC', needPageDisplayInfo: true,
      timeZone: 'GMT-03:00', _lang: 'pt_BR', _currency: 'BRL',
    })).module || {};
    const pacotes = m.trackingDetailLineList || [];
    if (!pacotes.length) pedidos.push({ orderId: o.orderId, code: '', name: nome, shop: o.storeName });

    pacotes.forEach((pk, i) => {
      // detailList vem do evento mais recente para o mais antigo
      const events = (pk.detailList || [])
        .map((e) => ({ time: e.time, text: e.trackingDetailDesc || e.trackingName }))
        .filter((e) => e.text && e.time);
      const eta = pk.etaInfo?.etaTimeStamp;
      pedidos.push({
        orderId: pacotes.length > 1 ? `${o.orderId}-${i + 1}` : o.orderId,
        code: pk.mailNo || '',
        name: pacotes.length > 1 ? `${nome} (pacote ${i + 1})` : nome,
        shop: o.storeName || '',
        carrierName: pk.logisticsCarrierName || '',
        eta: eta ? new Date(eta).toISOString().slice(0, 10) : '',
        status: events.length ? statusDoEvento(events[0].text) : 'aguardando',
        lastEvent: events[0] || null,
        events,
      });
    });
  }
  return { fonte: 'aliexpress', pedidos };
}

// Escolhe o coletor pelo site em que está rodando
async function coletarPedidos() {
  if (location.hostname.endsWith('shopee.com.br')) return coletarPedidosShopee();
  if (/(^|\.)aliexpress\.(com|us)$/.test(location.hostname)) return coletarPedidosAliExpress();
  throw new Error('abra a página de pedidos da Shopee ou do AliExpress (logado) e tente de novo');
}
