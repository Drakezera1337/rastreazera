// Endereços públicos do Rastreazera (preenchidos ao publicar).
// sitePublico: onde o site fica no GitHub Pages — usado no QR code que configura o celular.
// proxyPadrao: Cloudflare Worker (worker.js) que faz as consultas automáticas fora do PC.
// Versão publicada (atualizada por versao.py) — aparece em ⚙️
const RZ_VERSAO = 27;

const RZ_CONFIG = {
  sitePublico: 'https://drakezera1337.github.io/rastreazera/',
  proxyPadrao: 'https://rastreazera.xhydanx16.workers.dev',
  // Chave PÚBLICA das notificações (VAPID). A privada fica só no PC (push_vapid.pem, fora do git).
  pushChavePublica: 'BFZApd8CDw2ca6mNQiM4GYOJU70XcHeHFPKgqQkiADDiS2BftziWZ_HLHdKhCJcFCZnEOFNKI_V5q2jRkBk0518',
};
