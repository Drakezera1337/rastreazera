"""Servidor local do Rastreazera.

Serve os arquivos do site e repassa consultas de rastreio que o navegador
não pode fazer direto (bloqueio de CORS), igual ao worker.js em produção.

Também coordena a busca automática de pedidos:
- a extensão "Rastreazera Coletor" (coletor/) busca Shopee e AliExpress a cada 1 hora
  ou quando o botão "Buscar pedidos" pede (/api/busca/*);
- a extensão "OLX Dashboard" roda a Verificação Completa quando pedida (/api/olx/*);
- o Rastreazera lê /api/busca/estado e importa a última busca concluída.

Uso:  python server.py        (abre em http://localhost:5500)
"""
import json
import re
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
ROOT = Path(__file__).parent

# Iniciado com o Windows via pythonw (sem console): sys.stdout/stderr são None e o http.server
# quebraria ao registrar cada requisição. Manda tudo para server.log (só erros, ver log_request).
if sys.stdout is None or sys.stderr is None:
    _log = open(ROOT / "server.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

UPSTREAMS = {
    "spx": "https://spx.com.br/shipment/order/open/order/get_order_info?spx_tn={tn}&language_code=pt",
}

# ---- Estado das buscas (gravado em disco: sobrevive a reinícios) ----
# olx.solicitadoEm  pedido de Verificação Completa que a extensão OLX ainda não pegou
# olx.iniciadoEm    a extensão OLX começou
# olx.progresso     contas e status (o vcEstado da extensão OLX)
# olx.resultado     { pedidos, ts, parado } da última Verificação Completa
# busca.solicitadoEm  o botão "Buscar pedidos" pediu uma busca e o Coletor ainda não pegou
# busca.atual         busca em andamento: { inicio, origem, esperadas, fontes: { loja: {pedidos} | {erro} } }
# busca.ultima        última busca concluída (o Rastreazera importa quando fimEm for novo)
ESTADO_FILE = ROOT / "ponte_estado.json"
LOCK = threading.Lock()
SOLICITACAO_EXPIRA_MS = 30 * 60 * 1000  # pedido que ninguém pegou (Chrome fechado?) expira
OLX_SEM_RESPOSTA_MS = 3 * 60 * 1000     # extensão OLX não pegou o pedido da busca nesse tempo
OLX_PARADA_MS = 10 * 60 * 1000          # OLX começou mas parou de mandar progresso (Chrome fechou/travou)
BUSCA_MAX_MS = 40 * 60 * 1000           # busca que não terminou nesse tempo fecha com o que tiver


LOJAS = ("shopee", "aliexpress", "olx")


def agora_ms():
    return int(time.time() * 1000)


def ler_estado():
    try:
        estado = json.loads(ESTADO_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        estado = {}
    estado.setdefault("olx", {})
    estado.setdefault("busca", {})
    # Onde buscar pedidos (⚙️ do Rastreazera): lojas desmarcadas ficam de fora das buscas
    lojas = estado.setdefault("config", {}).setdefault("lojas", {})
    for loja in LOJAS:
        lojas.setdefault(loja, True)
    return estado


def gravar_estado(estado):
    ESTADO_FILE.write_text(json.dumps(estado, ensure_ascii=False), encoding="utf-8")


def atualizar_prazos(estado):
    """Expira pedidos esquecidos e fecha a busca atual quando todas as lojas responderam."""
    agora = agora_ms()
    olx, busca = estado["olx"], estado["busca"]
    for alvo in (olx, busca):
        if alvo.get("solicitadoEm") and agora - alvo["solicitadoEm"] > SOLICITACAO_EXPIRA_MS:
            alvo.pop("solicitadoEm")

    atual = busca.get("atual")
    if not atual:
        return
    fontes = atual["fontes"]
    # Loja desmarcada no meio da busca: deixa de ser esperada (se ainda não respondeu)
    ativas = estado["config"]["lojas"]
    atual["esperadas"] = [loja for loja in atual["esperadas"] if ativas.get(loja) or loja in fontes]
    if "olx" in atual["esperadas"] and "olx" not in fontes:
        # A OLX só é pedida depois que as outras lojas terminam (menos abas abertas ao mesmo tempo)
        outras = [loja for loja in atual["esperadas"] if loja != "olx"]
        if not atual.get("olxPedidoEm") and all(loja in fontes for loja in outras):
            atual["olxPedidoEm"] = agora
            olx["solicitadoEm"] = agora
        if olx.get("solicitadoEm") and agora - olx["solicitadoEm"] > OLX_SEM_RESPOSTA_MS:
            olx.pop("solicitadoEm")
            fontes["olx"] = {"erro": "extensão OLX não respondeu"}
        elif (atual.get("olxPedidoEm") and not olx.get("solicitadoEm")
              and agora - max(olx.get("sinalEm", 0), atual["olxPedidoEm"]) > OLX_PARADA_MS):
            fontes["olx"] = {"erro": "Verificação Completa parou no meio (o Chrome fechou?)"}
    if agora - atual["inicio"] > BUSCA_MAX_MS:
        for loja in atual["esperadas"]:
            fontes.setdefault(loja, {"erro": "não terminou"})
    if all(loja in fontes for loja in atual["esperadas"]):
        atual["fimEm"] = agora
        busca["ultima"] = atual
        busca["atual"] = None
        busca["publicar"] = True  # o celular recebe pelo Gist


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---------- GET ----------
    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/api/olx/estado", "/api/busca/estado"):
            return self.ler_ponte(url.path.split("/")[2])
        if url.path == "/api/config":
            with LOCK:
                estado = ler_estado()
            # O token do Gist nunca sai do servidor: só informa se está configurado
            resposta = {**estado["config"], "gistConfigurado": bool(estado.get("segredos", {}).get("gist"))}
            return self.send_json(200, resposta, cors=False)
        if url.path.lstrip("/") == ESTADO_FILE.name:
            return self.send_json(404, {"error": "não encontrado"}, cors=False)

        match = re.fullmatch(r"/api/(\w+)", url.path)
        if not match:
            return super().do_GET()

        service = match.group(1)
        tn = parse_qs(url.query).get("tn", [""])[0].strip().upper()
        if service not in UPSTREAMS or not re.fullmatch(r"[A-Z0-9]{8,30}", tn):
            return self.send_json(400, {"error": "requisição inválida"})

        req = urllib.request.Request(
            UPSTREAMS[service].format(tn=tn),
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                self.send_raw(res.status, res.read())
        except Exception as exc:  # noqa: BLE001
            self.send_json(502, {"error": f"falha ao consultar a transportadora: {exc}"})

    def ler_ponte(self, qual):
        with LOCK:
            estado = ler_estado()
            atualizar_prazos(estado)
            gravar_estado(estado)
        if qual == "olx":
            resposta = estado["olx"]
        else:
            busca = estado["busca"]
            resposta = {
                "solicitadoEm": busca.get("solicitadoEm"),
                "atual": busca.get("atual"),
                "ultima": busca.get("ultima"),
                "olxProgresso": estado["olx"].get("progresso"),
            }
        # Sem CORS liberado: só a própria página (mesma origem) e as extensões leem os pedidos
        self.send_json(200, resposta, cors=False)

    # ---------- POST ----------
    def do_POST(self):
        url = urlparse(self.path)
        match = re.fullmatch(r"/api/(olx|busca|config)(?:/(\w+))?", url.path)
        if not match or (match.group(1) != "config") != bool(match.group(2)):
            return self.send_json(404, {"error": "rota inexistente"}, cors=False)
        # Só o próprio Rastreazera e extensões do Chrome podem mexer na ponte:
        # impede que um site qualquer aberto no navegador dispare buscas ou envie pedidos.
        origem = self.headers.get("Origin", "")
        if not (origem.startswith("chrome-extension://") or re.fullmatch(r"http://(localhost|127\.0\.0\.1)(:\d+)?", origem)):
            return self.send_json(403, {"error": "origem não permitida"}, cors=False)
        if "application/json" not in self.headers.get("Content-Type", ""):
            return self.send_json(415, {"error": "use JSON"}, cors=False)
        try:
            tamanho = int(self.headers.get("Content-Length", 0))
            dados = json.loads(self.rfile.read(min(tamanho, 5_000_000)) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "JSON inválido"}, cors=False)

        acao = f"{match.group(1)}/{match.group(2) or 'salvar'}"
        with LOCK:
            estado = ler_estado()
            ok = self.aplicar(acao, dados, estado)
            atualizar_prazos(estado)
            gravar_estado(estado)
        if not ok:
            return self.send_json(404, {"error": "ação inexistente"}, cors=False)
        self.send_json(200, {"ok": True}, cors=False)

    @staticmethod
    def aplicar(acao, dados, estado):
        olx, busca = estado["olx"], estado["busca"]
        ativas = estado["config"]["lojas"]
        agora = agora_ms()

        if acao == "config/salvar":  # caixas "Onde buscar pedidos" do ⚙️ e o Gist da sincronização
            for loja, marcada in (dados.get("lojas") or {}).items():
                if loja in LOJAS and isinstance(marcada, bool):
                    ativas[loja] = marcada
            if "gist" in dados:
                segredos = estado.setdefault("segredos", {})
                gist = dados["gist"]
                if gist and re.fullmatch(r"[\w-]{20,255}", str(gist.get("token", ""))) \
                        and re.fullmatch(r"[0-9a-f]{20,40}", str(gist.get("gistId", ""))):
                    segredos["gist"] = {"token": gist["token"], "gistId": gist["gistId"]}
                    busca["publicar"] = bool(busca.get("ultima"))  # manda a última busca já existente
                elif gist is None:
                    segredos.pop("gist", None)
        elif acao == "busca/solicitar":  # botão "Buscar pedidos" do Rastreazera
            if not busca.get("atual") and any(ativas.values()):
                busca["solicitadoEm"] = agora
        elif acao == "busca/iniciar":  # Coletor começou (automática, botão ou ícone)
            esperadas = [e for e in dados.get("esperadas", []) if e in LOJAS and ativas.get(e)]
            busca.pop("solicitadoEm", None)
            if not esperadas:
                return True  # todas as lojas desmarcadas: nada a buscar
            if busca.get("atual"):
                return True  # já há uma busca esperando a OLX: o Coletor só atualiza as lojas dela
            busca["atual"] = {"inicio": agora, "origem": str(dados.get("origem", ""))[:60],
                              "esperadas": esperadas, "fontes": {}}
            # a OLX é pedida em atualizar_prazos, quando as outras lojas terminarem
        elif acao == "busca/cancelar":  # botão "Parar" do Coletor durante uma busca
            atual = busca.get("atual")
            busca.pop("solicitadoEm", None)
            if atual:
                for loja in atual["esperadas"]:
                    atual["fontes"].setdefault(loja, {"erro": "busca interrompida"})
                if not atual.get("olxPedidoEm"):
                    olx.pop("solicitadoEm", None)
        elif acao == "busca/fonte":  # Coletor terminou uma loja
            atual = busca.get("atual")
            loja = dados.get("fonte")
            if atual and loja in atual["esperadas"]:
                atual["fontes"][loja] = ({"erro": str(dados["erro"])[:200]} if dados.get("erro")
                                         else {"pedidos": dados.get("pedidos") or []})
        elif acao == "olx/solicitar":
            olx["solicitadoEm"] = agora
        elif acao == "olx/iniciado":
            olx.pop("solicitadoEm", None)
            olx["iniciadoEm"] = olx["sinalEm"] = agora
            olx["progresso"] = None
        elif acao == "olx/progresso":
            olx["progresso"] = dados
            olx["sinalEm"] = agora  # a cada conta: mostra que a verificação ainda está viva
        elif acao == "olx/resultado":
            resultado = {"pedidos": dados.get("pedidos") or [], "ts": agora, "parado": bool(dados.get("parado"))}
            olx["resultado"] = resultado
            olx["progresso"] = None
            atual = busca.get("atual")
            if atual and "olx" in atual["esperadas"] and "olx" not in atual["fontes"]:
                atual["fontes"]["olx"] = resultado
            elif not atual and ativas.get("olx"):
                # Verificação Completa feita pela dashboard da OLX: vira uma busca só da OLX
                busca["ultima"] = {"inicio": agora, "fimEm": agora, "origem": "dashboard OLX",
                                   "esperadas": ["olx"], "fontes": {"olx": resultado}}
                busca["publicar"] = True
        else:
            return False
        return True

    # As extensões consultam o estado a cada 15 s–1 min: registra só as requisições com erro
    def log_request(self, code="-", size="-"):
        if str(code).isdigit() and int(code) >= 400:
            super().log_request(code, size)

    # ---------- respostas ----------
    def send_json(self, status, data, cors=True):
        self.send_raw(status, json.dumps(data, ensure_ascii=False).encode(), cors)

    def send_raw(self, status, body, cors=True):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


# ---- Ponte com o celular pelo Gist (o site publicado não alcança este PC) ----
# Publica a última busca concluída em busca.json e o andamento da busca atual em andamento.json;
# confere pedido_busca.json (o botão "Buscar pedidos" do celular grava { ts } lá) — um pedido novo
# vira uma busca aqui. A cada 1 min quando ocioso; a cada 10 s com busca ou pedido em andamento.
GIST_API = "https://api.github.com/gists/"
GIST_INTERVALO_S = 60
GIST_INTERVALO_ATIVO_S = 10
PEDIDO_CELULAR_VALIDADE_MS = 30 * 60 * 1000  # pedido antigo (PC estava desligado) não dispara busca
COLETOR_SEM_RESPOSTA_MS = 150 * 1000          # o Coletor confere pedidos a cada 1 min
_andamento_publicado = None                  # último andamento enviado (só envia quando muda)


def gist_request(gist, method="GET", corpo=None):
    req = urllib.request.Request(
        GIST_API + gist["gistId"], method=method,
        data=json.dumps(corpo).encode() if corpo is not None else None,
        headers={"Authorization": f"Bearer {gist['token']}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "User-Agent": "Rastreazera"},
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def montar_andamento(estado):
    """Resumo da busca para o celular: etapa atual, lojas, contas da OLX e erros."""
    busca, olx = estado["busca"], estado["olx"]
    atual = busca.get("atual")
    andamento = {
        "pedido": busca.get("pedidoCelular"),
        "ultimaFimEm": (busca.get("ultima") or {}).get("fimEm"),
        "lojasAtivas": estado["config"]["lojas"],
        "etapa": "ociosa",
    }
    if atual:
        andamento["etapa"] = "buscando"
        andamento["busca"] = {
            "inicio": atual["inicio"],
            "origem": atual.get("origem", ""),
            "esperadas": atual["esperadas"],
            "fontes": {loja: ({"erro": r["erro"]} if "erro" in r else {"pedidos": len(r.get("pedidos") or [])})
                       for loja, r in atual["fontes"].items()},
            "olxPedida": bool(atual.get("olxPedidoEm")),
            "olxIniciada": bool(atual.get("olxPedidoEm")) and not olx.get("solicitadoEm"),
            "olxContas": (olx.get("progresso") or {}).get("contas") if atual.get("olxPedidoEm") else None,
        }
    elif busca.get("solicitadoEm"):
        andamento["etapa"] = "aguardando_coletor"
        andamento["aguardandoDesde"] = busca["solicitadoEm"]
        if agora_ms() - busca["solicitadoEm"] > COLETOR_SEM_RESPOSTA_MS:
            andamento["erro"] = ("A extensão Rastreazera Coletor não respondeu. O Chrome está aberto com ela? "
                                 "A busca fica pendente e roda quando ela abrir.")
    return andamento


def sincronizar_gist():
    """Uma rodada de sincronização. Devolve True se há busca/pedido em andamento (rodar de novo logo)."""
    global _andamento_publicado
    with LOCK:
        estado = ler_estado()
        atualizar_prazos(estado)
    gist = estado.get("segredos", {}).get("gist")
    if not gist:
        return False

    # 1) Pedido do celular
    arquivo = (gist_request(gist).get("files") or {}).get("pedido_busca.json")
    try:
        pedido_ts = int(json.loads(arquivo["content"]).get("ts", 0)) if arquivo else 0
    except (ValueError, TypeError, AttributeError):
        pedido_ts = 0
    with LOCK:
        estado = ler_estado()
        atualizar_prazos(estado)
        busca = estado["busca"]
        if pedido_ts > busca.get("pedidoCelularVisto", 0):
            busca["pedidoCelularVisto"] = pedido_ts
            pedido = {"ts": pedido_ts, "recebidoEm": agora_ms()}
            if agora_ms() - pedido_ts > PEDIDO_CELULAR_VALIDADE_MS:
                pedido["erro"] = "Pedido antigo ignorado (o PC estava desligado). Peça de novo."
            elif not any(estado["config"]["lojas"].values()):
                pedido["erro"] = "Nenhuma loja marcada em ⚙️ → Onde buscar pedidos (no PC)."
            elif not busca.get("atual"):
                busca["solicitadoEm"] = agora_ms()  # o Coletor pega em até 1 min
            busca["pedidoCelular"] = pedido
            print(f"Busca pedida pelo celular ({time.strftime('%d/%m %H:%M')})")
        gravar_estado(estado)

    # 2) Última busca concluída + andamento (um PATCH só, e só quando algo mudou)
    arquivos = {}
    ultima = busca.get("ultima")
    if busca.get("publicar") and ultima:
        arquivos["busca.json"] = {"content": json.dumps(ultima, ensure_ascii=False)}
    andamento = montar_andamento(estado)
    if andamento != _andamento_publicado:
        arquivos["andamento.json"] = {"content": json.dumps({**andamento, "ts": agora_ms()}, ensure_ascii=False)}
    if arquivos:
        gist_request(gist, "PATCH", {"files": arquivos})
        _andamento_publicado = andamento
        if "busca.json" in arquivos:
            with LOCK:
                estado = ler_estado()
                if (estado["busca"].get("ultima") or {}).get("fimEm") == ultima.get("fimEm"):
                    estado["busca"]["publicar"] = False
                    gravar_estado(estado)

    pedido = busca.get("pedidoCelular") or {}
    pedido_aberto = (pedido.get("recebidoEm", 0) > (busca.get("ultima") or {}).get("fimEm", 0)
                     and agora_ms() - pedido.get("recebidoEm", 0) < PEDIDO_CELULAR_VALIDADE_MS)
    return bool(busca.get("atual") or busca.get("solicitadoEm") or pedido_aberto)


def laco_gist():
    while True:
        ativo = False
        try:
            ativo = sincronizar_gist()
        except Exception as exc:  # noqa: BLE001 — sem internet, token trocado...: tenta na próxima rodada
            print(f"Gist: {exc}", file=sys.stderr)
        time.sleep(GIST_INTERVALO_ATIVO_S if ativo else GIST_INTERVALO_S)


class Servidor(ThreadingHTTPServer):
    # No Windows, SO_REUSEADDR deixa um segundo server.py escutar a mesma porta junto com o
    # primeiro (respostas misturadas). Sem ele, o segundo falha ao abrir a porta e sai.
    allow_reuse_address = sys.platform != "win32"


if __name__ == "__main__":
    try:
        servidor = Servidor(("", PORT), Handler)
    except OSError:
        # Já tem um server.py (ex.: o que inicia com o Windows) usando a porta
        sys.exit(f"Porta {PORT} em uso — o Rastreazera já está rodando em http://localhost:{PORT}")
    print(f"Rastreazera rodando em http://localhost:{PORT}")
    threading.Thread(target=laco_gist, daemon=True).start()
    servidor.serve_forever()
