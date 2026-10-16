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
from datetime import datetime
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
ROOT = Path(__file__).parent

# Iniciado com o Windows via pythonw (sem console): sys.stdout/stderr são None e o http.server
# quebraria ao registrar cada requisição. Manda tudo para server.log (só erros, ver log_request).
LOG_MAX_BYTES = 1_000_000  # acima disso, o log vira server.log.1 (só a versão anterior é guardada)

if sys.stdout is None or sys.stderr is None:
    _caminho_log = ROOT / "server.log"
    if _caminho_log.exists() and _caminho_log.stat().st_size > LOG_MAX_BYTES:
        _caminho_log.replace(ROOT / "server.log.1")
    _log = open(_caminho_log, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
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


COLETOR_ONLINE_MS = 3 * 60 * 1000  # o Coletor dá sinal a cada 1 min; sem sinal nesse tempo = Chrome fechado


def agenda_publica(busca):
    """Próxima busca automática para o app. Sem o horário do sinal (mudaria a cada minuto e geraria
    gravações no Gist): só "coletorOnline", que muda quando o Chrome abre/fecha."""
    agenda = busca.get("agenda") or {}
    online = bool(agenda.get("em")) and agora_ms() - agenda["em"] < COLETOR_ONLINE_MS
    return {"coletorOnline": online, "ativo": agenda.get("ativo", False), "proxima": agenda.get("proxima")}


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


# ---- FB Radar (fb/): anúncios da categoria Consoles de Video Game do Facebook Marketplace ----
# A extensão "FB Radar Coletor" (fb/coletor/) manda a página lida a cada poucos minutos (/api/fb/coleta).
# Aqui ficam os anúncios das cidades escolhidas (config.cidades; vazio = todas), com quando apareceram
# e mudanças de preço. Os novos vão para pendentesPush; laco_gist publica fb.json e avisa (push_fb.json).
FB_FILE = ROOT / "fb_estado.json"
FB_DIR = ROOT.parent / "fb-radar"  # repositório do FB Radar (servido em /fb/)
FB_GUARDAR_MS = 7 * 24 * 3600 * 1000  # anúncio some do painel 7 dias depois da última vez que apareceu
FB_MAX = 400
FB_PUBLICAR_MAX = 300
FB_AVISAR_ATRASO_MS = 30 * 60 * 1000  # anúncio criado antes da coleta anterior (achado na varredura completa) não avisa


def ler_fb():
    try:
        fb = json.loads(FB_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        fb = {}
    fb.setdefault("config", {}).setdefault("cidades", [])
    fb.setdefault("anuncios", {})
    return fb


def gravar_fb(fb):
    FB_FILE.write_text(json.dumps(fb, ensure_ascii=False), encoding="utf-8")


def sem_acento(texto):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", str(texto)) if unicodedata.category(c) != "Mn").lower().strip()


def titulo_base(a):
    return re.sub(r"[^a-z0-9]", "", sem_acento(a.get("titulo", "")))


def quase_iguais(x, y):
    """Títulos iguais ou com até 2 letras de diferença (erro de digitação em repost)."""
    if x == y:
        return True
    if min(len(x), len(y)) < 8 or abs(len(x) - len(y)) > 2:
        return False
    ant = list(range(len(y) + 1))
    for i in range(1, len(x) + 1):
        atual = [i]
        for j in range(1, len(y) + 1):
            atual.append(min(ant[j] + 1, atual[j - 1] + 1, ant[j - 1] + (x[i - 1] != y[j - 1])))
        ant = atual
    return ant[-1] <= 2


def e_repost(a, vistos):
    """Mesmo preço e título (quase) igual a um anúncio já guardado: vendedores repostam com ids e perfis diferentes."""
    base, preco = titulo_base(a), a.get("preco") or 0
    return any(p == preco and quase_iguais(b, base) for b, p in vistos)


def fb_publico(fb):
    """O que o app mostra (GET /api/fb/estado e fb.json no Gist)."""
    anuncios = sorted(fb["anuncios"].values(), key=lambda a: a.get("criadoEm") or a["vistoEm"], reverse=True)
    agenda = fb.get("agenda") or {}
    return {
        "anuncios": anuncios[:FB_PUBLICAR_MAX],
        "coleta": fb.get("coleta"),
        "agenda": {"ativo": agenda.get("ativo", False), "intervalo": agenda.get("intervalo"),
                   "proxima": agenda.get("proxima"), "em": agenda.get("em")},
        "cidades": fb["config"]["cidades"],
        "gistConfigurado": bool((fb.get("segredos") or {}).get("gist")),
        "avisos": fb.get("avisos", []),
    }


def aplicar_fb(acao, dados, fb):
    agora = agora_ms()
    if acao == "coleta":
        coleta = {"em": agora, "metodo": str(dados.get("metodo", ""))[:20]}
        if dados.get("erro"):
            coleta["erro"] = str(dados["erro"])[:200]
        if dados.get("aviso"):  # páginas seguintes falharam: veio só a primeira
            coleta["aviso"] = str(dados["aviso"])[:240]
        cidades = {sem_acento(c) for c in fb["config"]["cidades"]}
        novos, mudou = 0, False
        coleta_anterior = (fb.get("coleta") or {}).get("em") or 0
        ja_vistos = [(titulo_base(x), x.get("preco") or 0) for x in fb["anuncios"].values()]
        for a in dados.get("anuncios") or []:
            if not isinstance(a, dict) or not re.fullmatch(r"\d{5,25}", str(a.get("id", ""))):
                continue
            if cidades and sem_acento(a.get("cidade", "")) not in cidades:
                continue
            campos = {k: a.get(k) for k in ("titulo", "preco", "precoTexto", "cidade", "uf", "foto", "criadoEm",
                                             "vendedor", "vendido", "reservado")}
            atual = fb["anuncios"].get(a["id"])
            if not atual:
                fb["anuncios"][a["id"]] = {"id": a["id"], **campos, "vistoEm": agora, "ultimaVez": agora}
                novos += 1
                # A primeira coleta só preenche o painel; repost de anúncio já visto também não avisa
                recente = not a.get("criadoEm") or a["criadoEm"] > coleta_anterior - FB_AVISAR_ATRASO_MS
                if fb.get("base") and recente and not e_repost(a, ja_vistos):
                    fb.setdefault("pendentesPush", []).append(a["id"])
                ja_vistos.append((titulo_base(a), a.get("preco") or 0))
                mudou = True
                continue
            if campos["preco"] != atual.get("preco") and atual.get("preco") is not None:
                atual["precoAnterior"] = atual["preco"]
                atual["precoMudouEm"] = agora
            if any(atual.get(k) != v for k, v in campos.items() if k != "foto"):
                mudou = True
            atual.update(campos, ultimaVez=agora)
        if not coleta.get("erro"):
            fb["base"] = True
        coleta.update(n=len(dados.get("anuncios") or []), novos=novos)
        fb["coleta"] = coleta
        # Limpeza: some FB_GUARDAR_MS depois da última vez que apareceu e guarda no máximo FB_MAX
        lista = sorted(fb["anuncios"].values(), key=lambda x: x["vistoEm"], reverse=True)
        fb["anuncios"] = {x["id"]: x for x in lista[:FB_MAX] if agora - x.get("ultimaVez", x["vistoEm"]) < FB_GUARDAR_MS}
        fb["publicar"] = fb.get("publicar") or mudou or bool(coleta.get("erro"))
    elif acao == "agenda":
        fb["agenda"] = {"ativo": bool(dados.get("ativo")), "intervalo": int(dados.get("intervalo") or 0) or None,
                        "proxima": int(dados["proxima"]) if dados.get("proxima") else None, "em": agora}
    elif acao == "config":  # cidades e Gist próprio, pelo ⚙️ do FB Radar no PC
        cidades = dados.get("cidades")
        if isinstance(cidades, list):
            fb["config"]["cidades"] = [str(c).strip()[:60] for c in cidades if str(c).strip()][:30]
            fb["publicar"] = True
        gist = dados.get("gist")
        if gist is not None:
            if not (isinstance(gist, dict) and re.fullmatch(r"[\w-]{20,255}", str(gist.get("token", "")))
                    and re.fullmatch(r"[0-9a-f]{20,40}", str(gist.get("gistId", "")))):
                return False  # token/Gist em formato inválido: o app mostra o erro em vez de fingir que salvou
            fb.setdefault("segredos", {})["gist"] = {"token": gist["token"], "gistId": gist["gistId"]}
            fb["publicar"] = True  # manda os anúncios já guardados para o Gist novo
    else:
        return False
    return True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # /fb/ é o FB Radar, que fica no repositório próprio (pasta fb-radar ao lado desta)
    def translate_path(self, path):
        if path == "/fb" or path.startswith(("/fb/", "/fb?")):
            original = self.directory
            self.directory = str(FB_DIR)
            try:
                return super().translate_path(path[3:] or "/")
            finally:
                self.directory = original
        return super().translate_path(path)

    # ---------- GET ----------
    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/api/olx/estado", "/api/busca/estado"):
            return self.ler_ponte(url.path.split("/")[2])
        if url.path == "/api/correios":
            return self.consultar_correios(parse_qs(url.query).get("tn", [""])[0])
        if url.path == "/api/config":
            with LOCK:
                estado = ler_estado()
            # O token do Gist nunca sai do servidor: só informa se está configurado
            segredos = estado.get("segredos", {})
            resposta = {**estado["config"], "gistConfigurado": bool(segredos.get("gist")),
                        "rastreioConfigurado": bool(segredos.get("ship24") or segredos.get("t17"))}
            return self.send_json(200, resposta, cors=False)
        if url.path == "/api/fb/estado":
            with LOCK:
                fb = ler_fb()
            resposta = fb_publico(fb)
            # Só para o app no PC (não vai ao Gist): final do token em uso, para conferir qual está valendo
            resposta["gistTokenFim"] = ((fb.get("segredos") or {}).get("gist") or {}).get("token", "")[-4:]
            return self.send_json(200, resposta, cors=False)
        if url.path.lstrip("/") in (ESTADO_FILE.name, FB_FILE.name):
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
                "agenda": agenda_publica(busca),
            }
        # Sem CORS liberado: só a própria página (mesma origem) e as extensões leem os pedidos
        self.send_json(200, resposta, cors=False)

    def consultar_correios(self, tn):
        tn = tn.strip().upper()
        if not CODIGO_CORREIOS.fullmatch(tn):
            return self.send_json(400, {"error": "código dos Correios inválido"}, cors=False)
        with LOCK:
            chave = chave_rastreio(ler_estado())
        if not chave:
            return self.send_json(409, {"error": "chave da Ship24 não configurada (⚙️ no PC)"}, cors=False)
        try:
            resultado = rastreio_consultar(chave, [tn]).get(tn) or {"pendente": True}
        except Exception as exc:  # noqa: BLE001
            return self.send_json(502, {"error": f"Ship24: {exc}"}, cors=False)
        self.send_json(200, resultado, cors=False)

    # ---------- POST ----------
    def do_POST(self):
        url = urlparse(self.path)
        match = re.fullmatch(r"/api/(olx|busca|config|fb)(?:/(\w+))?", url.path)
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

        if match.group(1) == "fb":
            with LOCK:
                fb = ler_fb()
                ok = aplicar_fb(match.group(2), dados, fb)
                gravar_fb(fb)
            return self.send_json(200 if ok else 404, {"ok": True} if ok else {"error": "ação inexistente"}, cors=False)

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
            if dados.get("lojas"):
                estado["config"]["lojasEm"] = agora  # mais nova que um config.json antigo do celular
            if "ship24" in dados:
                chave = dados["ship24"]
                segredos = estado.setdefault("segredos", {})
                segredos.pop("t17", None)  # nome antigo do campo
                if chave and re.fullmatch(r"[\w.-]{10,300}", str(chave)):
                    segredos["ship24"] = str(chave)
                elif chave is None:
                    segredos.pop("ship24", None)
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
        elif acao == "busca/agenda":  # Coletor informa (a cada 1 min) se a automática está ligada e a próxima
            busca["agenda"] = {"ativo": bool(dados.get("ativo")),
                               "proxima": int(dados["proxima"]) if dados.get("proxima") else None,
                               "em": agora}
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
# Freio de gravação: o GitHub limita GRAVAÇÕES por conta (~80/min, ~500/h), dividido com os
# outros apps da mesma conta (OLX, Ofertazera, Auto Radar, Gestão). Passando disso responde 403
# e para de aceitar por um tempo. O andamento (que muda a cada etapa da busca) sobe no máximo a
# cada 30 s; o resultado final (busca.json) sobe na hora. Bloqueado: espera o pedido ou 1 min,
# dobrando até 15 min.
GIST_GRAVAR_MIN_S = 30
_andamento_gravado_em = 0.0


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
        "agenda": agenda_publica(busca),
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
    global _andamento_publicado, _andamento_gravado_em
    with LOCK:
        estado = ler_estado()
        atualizar_prazos(estado)
    gist = estado.get("segredos", {}).get("gist")
    if not gist:
        return False

    # 1) Pedido do celular
    arquivos_gist = gist_request(gist).get("files") or {}
    arquivo = arquivos_gist.get("pedido_busca.json")
    try:
        pedido_ts = int(json.loads(arquivo["content"]).get("ts", 0)) if arquivo else 0
    except (ValueError, TypeError, AttributeError):
        pedido_ts = 0
    # "Onde buscar pedidos" alterado pelo celular (config.json): vale se for mais novo que o do PC
    config_celular = json_do_arquivo(arquivos_gist, "config.json", {})
    with LOCK:
        estado = ler_estado()
        atualizar_prazos(estado)
        config = estado["config"]
        if isinstance(config_celular, dict) and int(config_celular.get("ts") or 0) > config.get("lojasEm", 0):
            for loja, marcada in (config_celular.get("lojas") or {}).items():
                if loja in LOJAS and isinstance(marcada, bool):
                    config["lojas"][loja] = marcada
            config["lojasEm"] = int(config_celular["ts"])
            print(f"Onde buscar pedidos alterado pelo celular: {config['lojas']}")
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
    if andamento != _andamento_publicado and (arquivos or time.time() - _andamento_gravado_em >= GIST_GRAVAR_MIN_S):
        arquivos["andamento.json"] = {"content": json.dumps({**andamento, "ts": agora_ms()}, ensure_ascii=False)}
    if arquivos:
        gist_request(gist, "PATCH", {"files": arquivos})
        if "andamento.json" in arquivos:
            _andamento_publicado, _andamento_gravado_em = andamento, time.time()
        if "busca.json" in arquivos:
            with LOCK:
                estado = ler_estado()
                if (estado["busca"].get("ultima") or {}).get("fimEm") == ultima.get("fimEm"):
                    estado["busca"]["publicar"] = False
                    gravar_estado(estado)

    try:
        processar_notificacoes(gist, arquivos_gist)
    except Exception as exc:  # noqa: BLE001 — notificação nunca derruba a sincronização
        print(f"Notificações: {exc}", file=sys.stderr)

    pedido = busca.get("pedidoCelular") or {}
    pedido_aberto = (pedido.get("recebidoEm", 0) > (busca.get("ultima") or {}).get("fimEm", 0)
                     and agora_ms() - pedido.get("recebidoEm", 0) < PEDIDO_CELULAR_VALIDADE_MS)
    return bool(busca.get("atual") or busca.get("solicitadoEm") or pedido_aberto)


# ---- Notificações push (Web Push) ----
# Os aparelhos se inscrevem em push.json (no Gist). A cada busca concluída, compara com a anterior
# e avisa: pedido novo, movimentação nova, pedido que saiu da lista de ativos (provavelmente entregue).
# A chave privada VAPID fica em push_vapid.pem (fora do git); a biblioteca, em .vendor/.
PUSH_PEM = ROOT / "push_vapid.pem"
PUSH_CONTATO = "mailto:276884055+Drakezera1337@users.noreply.github.com"  # exigido pelo padrão VAPID (sub): e-mail noreply do GitHub
NOMES_LOJA = {"shopee": "Shopee", "aliexpress": "AliExpress", "olx": "OLX"}
STATUS_OLX = {"entregue": "✅ Entregue", "transito": "🚚 Em trânsito", "preparacao": "🕓 Em preparação",
              "cancelamento": "⚠️ Cancelamento"}
_webpush = None


def carregar_webpush():
    global _webpush
    if _webpush is None:
        vendor = str(ROOT / ".vendor")
        if vendor not in sys.path:
            sys.path.insert(0, vendor)
        try:
            from pywebpush import WebPushException, webpush
            _webpush = (webpush, WebPushException)
        except ImportError as exc:
            print(f"Notificações desligadas: pywebpush não encontrado em .vendor ({exc})", file=sys.stderr)
            _webpush = False
    return _webpush or None


def json_do_arquivo(arquivos, nome, padrao):
    arquivo = arquivos.get(nome)
    try:
        return json.loads(arquivo["content"]) if arquivo else padrao
    except (ValueError, TypeError, KeyError):
        return padrao


def assinaturas_da_busca(ultima):
    """{codigo: {loja, nome, sig, texto}} das lojas que responderam, e o conjunto dessas lojas."""
    mapa, lojas_ok = {}, set()
    for loja, resultado in (ultima.get("fontes") or {}).items():
        if "erro" in resultado:
            continue
        lojas_ok.add(loja)
        for ped in resultado.get("pedidos") or []:
            if loja == "olx":
                codigo, nome, st = ped.get("codigoRastreio"), ped.get("titulo", ""), ped.get("statusTipo", "")
                sig, texto = st, STATUS_OLX.get(st, st)
            else:
                ev = ped.get("lastEvent") or {}
                codigo, nome = ped.get("code"), ped.get("name", "")
                sig, texto = f"{ped.get('status')}|{ev.get('time')}", ev.get("text") or ""
            if codigo:
                mapa[str(codigo).upper()] = {"loja": loja, "nome": nome[:60], "sig": sig, "texto": texto[:140]}
    return mapa, lojas_ok


def mensagens_de_novidades(anterior, atual, lojas_ok, apelidos):
    msgs = []
    nome = lambda cod, info: apelidos.get(cod) or info["nome"] or cod  # noqa: E731
    for cod, info in atual.items():
        if cod not in anterior:
            msgs.append(f"📦 Novo pedido ({NOMES_LOJA.get(info['loja'], info['loja'])}): {nome(cod, info)}")
        elif anterior[cod]["sig"] != info["sig"] and info["texto"]:
            msgs.append(f"{nome(cod, info)}: {info['texto']}")
    for cod, info in anterior.items():
        # Shopee/AliExpress tiram da lista de ativos o pedido entregue (a OLX mantém, com status)
        if cod not in atual and info["loja"] in lojas_ok and info["loja"] != "olx":
            msgs.append(f"✅ {nome(cod, info)}: saiu dos pedidos ativos da {NOMES_LOJA.get(info['loja'])} (provavelmente entregue)")
    return msgs


def enviar_push(inscricoes, payload):
    """Envia para cada aparelho; devolve os endpoints que não existem mais (404/410)."""
    lib = carregar_webpush()
    if not lib or not inscricoes:
        return []
    webpush, WebPushException = lib
    mortos = []
    for insc in inscricoes:
        try:
            webpush(subscription_info={"endpoint": insc["endpoint"], "keys": insc["keys"]},
                    data=json.dumps(payload, ensure_ascii=False), vapid_private_key=str(PUSH_PEM),
                    vapid_claims={"sub": PUSH_CONTATO}, ttl=12 * 3600, timeout=20)
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                mortos.append(insc["endpoint"])
            print(f"Push para {insc.get('aparelho', '?')}: {exc}", file=sys.stderr)
        except (KeyError, TypeError) as exc:
            print(f"Inscrição inválida em push.json: {exc}", file=sys.stderr)
    return mortos


def payload_de(msgs):
    if len(msgs) == 1:
        return {"title": "Rastreazera", "body": msgs[0], "tag": "rastreazera-busca"}
    corpo = "\n".join(msgs[:6]) + (f"\n…e mais {len(msgs) - 6}" if len(msgs) > 6 else "")
    return {"title": f"Rastreazera · {len(msgs)} novidades", "body": corpo, "tag": "rastreazera-busca"}


# ---- Correios pela Ship24 (API oficial; chave só no PC, em segredos.ship24) ----
# trackers/track cria o acompanhamento na 1ª consulta de um código (gasta 1 da cota mensal: 10 no
# plano grátis) e depois só devolve os resultados (não gasta de novo). Por isso só entram códigos
# dos Correios que não vieram do AliExpress (esses já trazem o histórico da importação).
# O resultado vai para rastreios.json no Gist: { codigo: { status, events, atualizadoEm } }.
SHIP24_TRACK = "https://api.ship24.com/public/v1/trackers/track"
CODIGO_CORREIOS = re.compile(r"[A-Z]{2}\d{9}[A-Z]{2}")
SHIP24_STATUS = {"delivered": "entregue", "out_for_delivery": "saiu", "available_for_pickup": "saiu",
                 "in_transit": "transito", "info_received": "aguardando", "pending": "aguardando",
                 "failed_attempt": "problema", "exception": "problema"}


def chave_rastreio(estado):
    segredos = estado.get("segredos", {})
    return segredos.get("ship24") or segredos.get("t17")  # "t17": nome antigo do campo (mesma chave)


def ship24_hora_ms(ev):
    # occurrenceDatetime é a hora local da transportadora, sem fuso. O campo "datetime" repete essa
    # mesma hora com um "Z" que NÃO é UTC de verdade — por isso não é usado. Sem utcOffset no evento,
    # vale o horário de Brasília (é como os Correios mostram).
    texto = ev.get("occurrenceDatetime") or ""
    try:
        dt = datetime.fromisoformat(texto)
        if dt.tzinfo is None:
            dt = datetime.fromisoformat(texto + (ev.get("utcOffset") or "-03:00"))
    except ValueError:
        return 0
    return int(dt.timestamp() * 1000)


def ship24_normalizar(tracking):
    eventos, vistos = [], set()
    for ev in tracking.get("events") or []:
        item = {"time": ship24_hora_ms(ev), "text": (ev.get("status") or "").strip()[:300],
                "location": (ev.get("location") or "").strip()[:120]}
        if item["text"] and item["time"] and (item["time"], item["text"]) not in vistos:
            vistos.add((item["time"], item["text"]))
            eventos.append(item)
    eventos.sort(key=lambda e: e["time"], reverse=True)
    marco = (tracking.get("shipment") or {}).get("statusMilestone")
    status = SHIP24_STATUS.get(marco, "transito")
    if eventos and status == "transito" and re.search(r"tribut|taxa|pagamento", eventos[0]["text"], re.I):
        status = "fiscalizacao"
    return {"status": status, "events": eventos[:60]}


def rastreio_consultar(chave, codigos):
    """{codigo: {status, events} | {pendente: True} | {erro}} — uma chamada por código."""
    resultado = {}
    for codigo in codigos:
        req = urllib.request.Request(SHIP24_TRACK, method="POST", data=json.dumps({"trackingNumber": codigo}).encode(),
                                     headers={"Authorization": f"Bearer {chave}",
                                              "Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=90) as res:  # 1ª consulta de um código pode levar até 1 min
                trackings = (json.loads(res.read()).get("data") or {}).get("trackings") or []
        except urllib.error.HTTPError as exc:
            corpo = exc.read()[:300].decode("utf-8", "replace")
            if exc.code in (401, 403):
                raise RuntimeError(f"chave da Ship24 recusada ({exc.code})") from exc
            resultado[codigo] = {"erro": f"Ship24 {exc.code}: {corpo}"}
            continue
        r = ship24_normalizar(trackings[0]) if trackings else {"events": []}
        resultado[codigo] = r if r["events"] else {"pendente": True}
    return resultado


def atualizar_correios(gist, arquivos_gist, estado, apelidos):
    """Consulta os Correios a caminho, grava rastreios.json e devolve mensagens das mudanças."""
    chave = chave_rastreio(estado)
    if not chave:
        return []
    pacotes = [p for p in json_do_arquivo(arquivos_gist, "rastreazera.json", [])
               if isinstance(p, dict) and not p.get("deleted") and p.get("status") != "entregue"
               and CODIGO_CORREIOS.fullmatch(str(p.get("code", "")).upper())
               and not str(p.get("orderRef") or "").startswith("aliexpress:")]
    if not pacotes:
        return []
    anteriores = json_do_arquivo(arquivos_gist, "rastreios.json", {})
    novos = dict(anteriores)
    msgs = []
    for codigo, r in rastreio_consultar(chave, sorted({str(p["code"]).upper() for p in pacotes})).items():
        if not r.get("events"):
            continue  # pendente/sem dados: mantém o que já havia
        ant = anteriores.get(codigo) or {}
        mudou = not ant.get("events") or ant["events"][0] != r["events"][0] or ant.get("status") != r["status"]
        if mudou:
            novos[codigo] = {**r, "atualizadoEm": agora_ms()}
            if ant.get("events"):  # primeira vez só registra a base
                msgs.append(f"{apelidos.get(codigo) or codigo}: {r['events'][0]['text']}")
    if novos != anteriores:
        gist_request(gist, "PATCH", {"files": {"rastreios.json": {"content": json.dumps(novos, ensure_ascii=False)}}})
    return msgs


def processar_notificacoes(gist, arquivos_gist):
    if not PUSH_PEM.exists():
        return
    inscricoes = [i for i in json_do_arquivo(arquivos_gist, "push.json", []) if isinstance(i, dict) and i.get("endpoint")]
    with LOCK:
        estado = ler_estado()
    controle = estado.get("push") or {}
    mortos = []

    # Teste pedido pelo botão "Enviar teste" do aparelho
    testes = controle.get("testes", {})
    for insc in inscricoes:
        if insc.get("testeEm", 0) > testes.get(insc["endpoint"], 0):
            testes[insc["endpoint"]] = insc["testeEm"]
            mortos += enviar_push([insc], {"title": "Rastreazera", "body": "🔔 Teste: as notificações estão funcionando neste aparelho!",
                                           "tag": "rastreazera-teste"})
            print(f"Notificação de teste enviada ({insc.get('aparelho', '?')})")
    controle["testes"] = testes

    # Novidades da última busca concluída (uma vez por busca)
    ultima = estado["busca"].get("ultima") or {}
    if ultima.get("fimEm") and ultima["fimEm"] != controle.get("fimEmProcessado"):
        atual, lojas_ok = assinaturas_da_busca(ultima)
        anterior = controle.get("assinaturas")
        apelidos = {str(p.get("code", "")).upper(): p.get("name") for p in json_do_arquivo(arquivos_gist, "rastreazera.json", [])
                    if isinstance(p, dict) and not p.get("deleted") and p.get("name")}
        msgs = mensagens_de_novidades(anterior, atual, lojas_ok, apelidos) if anterior is not None else []
        # na primeira busca só registra a base (não notifica o que já existia)
        try:
            msgs += atualizar_correios(gist, arquivos_gist, estado, apelidos)
        except Exception as exc:  # noqa: BLE001 — Ship24 fora do ar não impede o resto
            print(f"Ship24: {exc}", file=sys.stderr)
        if msgs:
            mortos += enviar_push(inscricoes, payload_de(msgs))
            print(f"Notificação: {len(msgs)} novidade(s) para {len(inscricoes)} aparelho(s)")
        base = {cod: info for cod, info in (anterior or {}).items() if info["loja"] not in lojas_ok}
        base.update(atual)
        controle["assinaturas"] = base
        controle["fimEmProcessado"] = ultima["fimEm"]

    with LOCK:
        estado = ler_estado()
        estado["push"] = controle
        gravar_estado(estado)

    # Aparelhos que não existem mais saem do push.json
    if mortos:
        vivos = [i for i in inscricoes if i["endpoint"] not in set(mortos)]
        gist_request(gist, "PATCH", {"files": {"push.json": {"content": json.dumps(vivos, indent=1)}}})


FB_REPUBLICAR_MS = 10 * 60 * 1000  # sem novidade, republica fb.json mesmo assim (o celular mostra a hora da última conferência)
# Freio de gravação (limite do GitHub por conta, dividido com os outros apps): fb.json sobe no máximo
# a cada 2 min — o que chegar nesse meio-tempo vai junto. Os avisos push saem na hora, não dependem disto.
FB_GRAVAR_MIN_MS = 2 * 60 * 1000


def fb_texto(a):
    preco = a.get("precoTexto") or (f"R${a['preco']:.0f}" if a.get("preco") else "sem preço")
    return f"{a.get('titulo', '')[:60]} · {preco} · {a.get('cidade', '')}"


FB_SINC_INTERVALO_MS = 50 * 1000
_fb_sinc_em = 0


def sincronizar_fb():
    """Uma rodada no Gist próprio do FB Radar (no máximo a cada ~1 min)."""
    global _fb_sinc_em
    if agora_ms() - _fb_sinc_em < FB_SINC_INTERVALO_MS:
        return
    _fb_sinc_em = agora_ms()
    with LOCK:
        gist = (ler_fb().get("segredos") or {}).get("gist")
    if gist:
        processar_fb(gist, gist_request(gist).get("files") or {})


FB_AVISOS_MAX = 60  # histórico de avisos mostrado na aba Notificações


def regras_ativas(arquivos_gist):
    """Regras criadas no app (aba Notificações → +), guardadas em regras.json no Gist do FB Radar."""
    return [r for r in json_do_arquivo(arquivos_gist, "regras.json", []) if isinstance(r, dict) and r.get("ativo", True)]


def casa_regra(a, r):
    """O anúncio bate com a regra? Palavras: basta uma (cada uma pode ter várias palavras, todas no título);
    "não pode ter": nenhuma; preço entre mín e máx (sem preço não passa quando há máximo); cidade na lista."""
    titulo = sem_acento(a.get("titulo", ""))
    termos = lambda campo: [sem_acento(p) for p in (r.get(campo) or []) if str(p).strip()]  # noqa: E731
    contem = lambda termo: all(w in titulo for w in termo.split())  # noqa: E731
    if termos("palavras") and not any(contem(t) for t in termos("palavras")):
        return False
    if any(contem(t) for t in termos("excluir")):
        return False
    preco = a.get("preco") or 0
    if r.get("precoMin") and preco < float(r["precoMin"]):
        return False
    if r.get("precoMax") and (not preco or preco > float(r["precoMax"])):
        return False
    cidades = {sem_acento(c) for c in r.get("cidades") or []}
    return not cidades or sem_acento(a.get("cidade", "")) in cidades


def processar_fb(gist, arquivos_gist):
    """Publica fb.json (a cada conferência) e avisa os aparelhos de push.json dos anúncios novos que batem
    com alguma regra ativa (sem regras: todos os novos). Cada aviso entra no histórico (fb.json → avisos)."""
    regras = regras_ativas(arquivos_gist)
    with LOCK:
        fb = ler_fb()
        pendentes = fb.pop("pendentesPush", [])
        avisar = []  # (anúncio, nome da regra)
        for i in pendentes:
            a = fb["anuncios"].get(i)
            if not a:
                continue
            if not regras:
                avisar.append((a, ""))
                continue
            regra = next((r for r in regras if casa_regra(a, r)), None)
            if regra:
                avisar.append((a, str(regra.get("nome") or "Regra")[:40]))
        if avisar:
            novos_avisos = [{"id": a["id"], "titulo": a.get("titulo", ""), "precoTexto": a.get("precoTexto", ""),
                             "cidade": a.get("cidade", ""), "foto": a.get("foto", ""), "regra": nome, "em": agora_ms()}
                            for a, nome in avisar]
            fb["avisos"] = (novos_avisos + fb.get("avisos", []))[:FB_AVISOS_MAX]
        quer = fb.pop("publicar", False) or bool(avisar)
        desde = agora_ms() - fb.get("publicadoEm", 0)
        publicar = (quer and desde >= FB_GRAVAR_MIN_MS) or desde > FB_REPUBLICAR_MS
        if quer and not publicar:
            fb["publicar"] = True  # fica pendente pra próxima rodada (sobe junto em até 2 min)
        if publicar:
            fb["publicadoEm"] = agora_ms()
        gravar_fb(fb)
    if publicar and fb.get("coleta"):
        conteudo = json.dumps({**fb_publico(fb), "ts": agora_ms()}, ensure_ascii=False)
        gist_request(gist, "PATCH", {"files": {"fb.json": {"content": conteudo}}})

    if not PUSH_PEM.exists():
        return
    inscricoes = [i for i in json_do_arquivo(arquivos_gist, "push.json", []) if isinstance(i, dict) and i.get("endpoint")]
    mortos = []
    testes = fb.get("testesPush", {})
    for insc in inscricoes:
        if insc.get("testeEm", 0) > testes.get(insc["endpoint"], 0):
            testes[insc["endpoint"]] = insc["testeEm"]
            mortos += enviar_push([insc], {"title": "FB Radar", "body": "🔔 Teste: as notificações estão funcionando neste aparelho!",
                                           "tag": "fbradar-teste"})
    if avisar and inscricoes:
        if len(avisar) == 1:
            a, regra = avisar[0]
            payload = {"title": f"{'🔔 ' + regra + ': ' if regra else '🎮 '}{a.get('precoTexto') or 'Novo anúncio'} · {a.get('titulo', '')[:50]}",
                       "body": f"{a.get('cidade', '')} — toque para abrir no Facebook", "tag": f"fbradar-{a['id']}",
                       "url": f"https://www.facebook.com/marketplace/item/{a['id']}/", "image": a.get("foto") or None}
        else:
            linhas = [(f"[{regra}] " if regra else "") + fb_texto(a) for a, regra in avisar]
            corpo = "\n".join(linhas[:6]) + (f"\n…e mais {len(linhas) - 6}" if len(linhas) > 6 else "")
            payload = {"title": f"🎮 {len(avisar)} anúncios novos", "body": corpo, "tag": "fbradar-novos"}
        mortos += enviar_push(inscricoes, payload)
        print(f"FB Radar: {len(avisar)} aviso(s) para {len(inscricoes)} aparelho(s)")
    with LOCK:
        fb_atual = ler_fb()
        fb_atual["testesPush"] = testes
        gravar_fb(fb_atual)
    if mortos:
        vivos = [i for i in inscricoes if i["endpoint"] not in set(mortos)]
        gist_request(gist, "PATCH", {"files": {"push.json": {"content": json.dumps(vivos, indent=1)}}})


def _espera_bloqueio(exc, espera):
    """GitHub bloqueou (403/429 por limite)? Devolve quantos segundos esperar, senão None."""
    if not isinstance(exc, urllib.error.HTTPError) or exc.code not in (403, 429):
        return None
    pedido = int(exc.headers.get("Retry-After") or 0)
    reset = (int(exc.headers.get("X-RateLimit-Reset") or 0) - time.time()) if exc.headers.get("X-RateLimit-Remaining") == "0" else 0
    return max(pedido, reset, espera)


def laco_gist():
    espera = 60  # bloqueio do GitHub: espera o pedido ou 1 min, dobrando até 15 min
    while True:
        ativo = False
        bloqueio = None
        try:
            ativo = sincronizar_gist()
        except Exception as exc:  # noqa: BLE001 — sem internet, token trocado...: tenta na próxima rodada
            bloqueio = _espera_bloqueio(exc, espera)
            print(f"Gist: {exc}" + (f" — GitHub bloqueou, tento de novo em {int(bloqueio)} s" if bloqueio else ""), file=sys.stderr)
        if bloqueio is None:
            try:
                sincronizar_fb()
            except Exception as exc:  # noqa: BLE001
                bloqueio = _espera_bloqueio(exc, espera)
                print(f"FB Radar: {exc}" + (f" — GitHub bloqueou, tento de novo em {int(bloqueio)} s" if bloqueio else ""), file=sys.stderr)
        if bloqueio:
            espera = min(espera * 2, 900)
            time.sleep(bloqueio)
            continue
        espera = 60
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
