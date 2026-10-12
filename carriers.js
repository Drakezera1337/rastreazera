// Transportadoras conhecidas: como reconhecer o código e onde rastrear.
// A ordem importa: a primeira regra que casar com o código vence.
const CARRIERS = {
  correios: {
    name: 'Correios',
    color: '#eab308',
    yq: '2151', // código da transportadora no 17TRACK
    match: (c) => /^[A-Z]{2}\d{9}BR$/.test(c),
    url: (c) => `https://www.linkcorreios.com.br/?id=${c}`,
  },
  shopee: {
    name: 'Shopee Xpress',
    color: '#ee4d2d',
    match: (c) => /^BR\d{12,14}[A-Z]?$/.test(c) || /^SPX/.test(c),
    url: (c) => `https://spx.com.br/track?${c}`,
  },
  cainiao: {
    name: 'AliExpress / Cainiao',
    color: '#ff6a00',
    yq: '190271',
    match: (c) => /^(LP\d{12,16}|CNBR\w+|CAINIAO\w+|AEO?\d+|ALS\w+)$/.test(c),
    url: (c) => `https://global.cainiao.com/newDetail.htm?mailNoList=${c}`,
  },
  postal_intl: {
    name: 'Correio internacional',
    color: '#0ea5e9',
    yq: '2151',
    // Padrão UPU (S10) de outros países: entra no Brasil via Correios
    match: (c) => /^[A-Z]{2}\d{9}[A-Z]{2}$/.test(c),
    url: (c) => `https://www.linkcorreios.com.br/?id=${c}`,
  },
  jadlog: {
    name: 'Jadlog',
    color: '#dc2626',
    yq: '101052',
    match: (c) => /^\d{14}$/.test(c),
    url: (c) => `https://www.jadlog.com.br/jadlog/tracking?cte=${c}`,
  },
  mercadolivre: {
    name: 'Mercado Envios',
    color: '#facc15',
    match: () => false,
    url: () => 'https://www.mercadolivre.com.br/minhas-compras',
  },
  loggi: {
    name: 'Loggi',
    color: '#00a5e3',
    yq: '100457',
    match: () => false,
    url: (c) => `https://www.loggi.com/rastreador/${c}`,
  },
  outra: {
    name: 'Outra',
    color: '#64748b',
    match: () => false,
    url: (c) => `https://t.17track.net/pt#nums=${c}`,
  },
};

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/\s+/g, '');
}

function detectCarrier(code) {
  const c = normalizeCode(code);
  if (!c) return null;
  for (const [key, carrier] of Object.entries(CARRIERS)) {
    if (carrier.match(c)) return key;
  }
  return 'outra';
}

// O 17TRACK reconhece praticamente qualquer transportadora; serve de alternativa universal.
function universalTrackUrl(code) {
  return `https://t.17track.net/pt#nums=${encodeURIComponent(normalizeCode(code))}`;
}
