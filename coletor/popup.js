// Painel da extensão: liga/desliga a busca automática (a cada 1 hora) e mostra o status.
const $ = (id) => document.getElementById(id);

function hora(ts) {
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function render(e) {
  $('estado').classList.toggle('ligado', e.ativo);
  $('estadoTexto').textContent = e.ativo ? 'Busca automática ligada (a cada 1 hora)' : 'Busca automática parada';
  $('btnAlternar').textContent = e.ativo ? '⏹ Parar' : '▶ Iniciar';
  $('btnAlternar').classList.toggle('parar', e.ativo);
  $('btnAgora').disabled = Boolean(e.emAndamento);
  $('andamento').textContent = e.emAndamento ? `Buscando agora: ${e.emAndamento.loja}…` : '';

  const r = e.ultimoResultado;
  if (r) {
    const partes = ['shopee', 'aliexpress', 'olx'].filter((k) => r[k]).map((k) => `${{ shopee: 'Shopee', aliexpress: 'AliExpress', olx: 'OLX' }[k]}: ${r[k]}`);
    if (r.erro) partes.push(r.erro);
    if (r.parada) partes.push('interrompida');
    $('ultima').textContent = `Última busca (${hora(r.ts)}): ${partes.join(' · ') || '—'}`;
  } else {
    $('ultima').textContent = 'Nenhuma busca feita ainda.';
  }
  $('proxima').textContent = e.ativo && e.proxima ? `Próxima busca: ${hora(e.proxima)}` : '';
}

let ativo = false;

function enviar(tipo) {
  chrome.runtime.sendMessage({ tipo }, (e) => { ativo = e.ativo; render(e); });
}

$('btnAlternar').addEventListener('click', () => enviar(ativo ? 'parar' : 'iniciar'));
$('btnAgora').addEventListener('click', () => enviar('buscarAgora'));

// Atualiza enquanto o painel estiver aberto
function atualizar() {
  chrome.runtime.sendMessage({ tipo: 'status' }, (e) => { ativo = e.ativo; render(e); });
}
atualizar();
setInterval(atualizar, 1500);
