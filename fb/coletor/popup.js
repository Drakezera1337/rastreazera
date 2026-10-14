// Painel da extensão: liga/desliga a conferência automática, escolhe o intervalo e mostra o status.
const $ = (id) => document.getElementById(id);

function hora(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

let ativo = false;

function render(e) {
  ativo = e.ativo;
  $('estado').classList.toggle('ligado', e.ativo);
  $('estadoTexto').textContent = e.ativo ? `Ligado (a cada ${e.intervalo} min)` : 'Parado';
  $('btnAlternar').textContent = e.ativo ? '⏹ Parar' : '▶ Iniciar';
  $('btnAlternar').classList.toggle('parar', e.ativo);
  $('btnAgora').disabled = Boolean(e.emAndamento);
  $('btnAgora').textContent = e.emAndamento ? 'Conferindo…' : '🔄 Conferir agora';
  if (document.activeElement !== $('intervalo')) $('intervalo').value = String(e.intervalo);

  const u = e.ultima;
  $('ultima').className = u?.erro ? 'erro' : '';
  $('ultima').textContent = !u ? 'Nenhuma conferência feita ainda.'
    : u.erro ? `Última (${hora(u.em)}): ${u.erro}`
      : `Última (${hora(u.em)}): ${u.n} anúncios lidos`;
  $('proxima').textContent = e.ativo && e.proxima ? `Próxima: ${hora(e.proxima)}` : '';
}

function enviar(msg) {
  chrome.runtime.sendMessage(msg, render);
}

$('btnAlternar').addEventListener('click', () => enviar({ tipo: ativo ? 'parar' : 'iniciar' }));
$('btnAgora').addEventListener('click', () => enviar({ tipo: 'agora' }));
$('intervalo').addEventListener('change', (e) => enviar({ tipo: 'intervalo', valor: e.target.value }));

enviar({ tipo: 'status' });
setInterval(() => enviar({ tipo: 'status' }), 1500);
