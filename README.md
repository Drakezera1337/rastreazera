# Rastreazera 📦

Todos os seus rastreios (Correios, Shopee, AliExpress, Jadlog…) em um só lugar, no computador e no celular.

Site estático (HTML + CSS + JS, sem build), feito para rodar no **GitHub Pages**, com um pequeno
proxy para as consultas automáticas (`server.py` no PC, `worker.js` na Cloudflare em produção).

## Rodar localmente

```bash
python server.py
```

Abra http://localhost:5500. O `server.py` serve o site **e** faz as consultas na transportadora.

**Inicia sozinho com o Windows:** o atalho `Rastreazera (servidor)` na pasta Inicializar
(`shell:startup`) roda `pythonw server.py` sem janela ao fazer login. Erros vão para `server.log`.
Para desligar o início automático, apague esse atalho. Para parar o servidor agora, encerre o
processo `pythonw.exe` no Gerenciador de Tarefas. Rodar `python server.py` com ele já ativo só avisa e sai.

## Recursos

- Cadastro por código de rastreio, com **detecção automática da transportadora**
- **Shopee Xpress**: consulta direto na SPX — linha do tempo completa no site, último evento no card
  e **status atualizado sozinho** (ao abrir o site, a cada 30 min por pacote)
- **Demais transportadoras**: resultado via widget oficial do 17TRACK (Correios, Cainiao/AliExpress, Jadlog, Loggi…)
- Botão **Site oficial** da transportadora como alternativa
- Status, previsão e observações; busca e filtros; colar um código na página (Ctrl+V) já abre o cadastro
- Funciona como app no celular (**Adicionar à tela inicial**)
- **Sincronização entre aparelhos** via Gist secreto do GitHub (opcional)
- Backup: exportar/importar JSON

## Busca automática a cada 1 hora (extensão Rastreazera Coletor)

A extensão em `coletor/` roda no seu Chrome. No painel dela (clique no ícone): **▶ Iniciar** liga a busca
automática — busca na hora e depois **a cada 1 hora** (e ao abrir o Chrome, se já passou da hora); **⏹ Parar**
desliga e interrompe a busca em andamento; **Buscar agora** faz uma busca avulsa. Cada busca junta as três lojas:

- abre **uma** aba em segundo plano e coleta a **Shopee** e depois o **AliExpress** (`coletor/coletores.js`),
  com a sessão logada no Chrome — uma página pesada de cada vez — e fecha a aba;
- só então o `server.py` pede a **Verificação Completa** à extensão **OLX Dashboard** (se ela parar de dar
  sinal por 10 min, p. ex. o Chrome fechou, a busca fecha com as outras lojas);
- quando as três respondem, o Rastreazera importa e o 🔔 mostra o resumo
  ("3 pedidos Shopee (1 novo) · 2 pedidos AliExpress (sem novidades) · 1 pedido OLX (1 novo)").

O botão **🔄 Buscar pedidos** do Rastreazera também faz uma busca na hora (mesmo com a automática parada).

**Onde buscar:** em ⚙️ → **Onde buscar pedidos**, desmarque Shopee, AliExpress ou OLX para deixar a loja de fora
das buscas (automática e pelo botão). A escolha fica no `server.py` (`/api/config`), então vale para o Coletor
no Chrome e para qualquer navegador. Com a OLX desmarcada, a Verificação Completa não é pedida.
Buscas que terminam com o Rastreazera fechado são importadas quando ele abrir.

**Instalar:** Chrome → `chrome://extensions` → ative o **Modo do desenvolvedor** → **Carregar sem compactação**
→ escolha a pasta `coletor`. Entre (uma vez) na Shopee e no AliExpress **nesse Chrome**.

**Requisitos:** Chrome aberto com as duas extensões e o `server.py` rodando.
## Importar pedidos manualmente (Shopee e AliExpress)

Duas formas, com os mesmos coletores (`coletor/coletores.js`, que só **leem** a sua conta):

- **Agente no Claude Code**: digite `/importar-pedidos` (ou `/importar-pedidos aliexpress`). O Claude abre as
  páginas de pedidos no navegador embutido (você faz o login uma vez), coleta os pedidos a caminho e cadastra aqui.
- **Favorito**: em ⚙️ → **Importar pedidos**, arraste o botão **📥 Importar pedidos** para a barra de favoritos.
  Com a página de pedidos da Shopee (shopee.com.br/user/purchase) ou do AliExpress
  (aliexpress.com/p/order/index.html) aberta e logada, clique nele.

Pedidos já cadastrados não são duplicados (compara código de rastreio e número do pedido) — reimportar
**atualiza** último evento, histórico, status e previsão. Pedidos sem código de rastreio ainda são ignorados.

O AliExpress no Brasil entrega pelos **Correios** (códigos `NN…BR`): o histórico completo vem na importação
e aparece na linha do tempo do site, com opção de consultar no 17TRACK.
## Notificações (🔔)

O sininho no topo guarda o histórico (últimas 100) e mostra quantas são novas:

- **Fim de cada busca**: uma notificação com o resumo por loja, por exemplo
  "3 pedidos Shopee (1 novo) · 2 pedidos AliExpress (sem novidades) · 1 pedido OLX (1 novo)".
  O agente `/importar-pedidos` junta as três lojas numa notificação só; o botão **Buscar pedidos** (OLX)
  e o favorito geram o resumo da loja que buscaram. Falhas aparecem no lugar ("OLX: extensão não respondeu").
- **Mudança de status** detectada na consulta automática (Shopee Xpress), ex.: "PS5: 📍 Saiu para entrega".

## Pedidos da OLX (extensão OLX Dashboard)

O botão **🔄 Buscar pedidos** (e o agente `/importar-pedidos`) roda a **Verificação Completa** da extensão
*OLX Dashboard* (extensão separada, instalada no mesmo Chrome), que entra em cada conta OLX cadastrada e
junta os pedidos. A ponte é o `server.py`:

1. Quando uma busca começa (a cada 1 h pelo Coletor, ou pelo botão), o `server.py` registra o pedido da OLX.
2. A extensão, no Chrome, confere `GET /api/olx/estado` a cada ~15 s, roda a verificação e envia o
   progresso por conta e o resultado (`/api/olx/progresso`, `/api/olx/resultado`).
3. O Rastreazera importa: em trânsito com código entram; em preparação contam como "sem código";
   entregues só atualizam pacotes já cadastrados; cancelados são ignorados.

Verificações feitas pelo botão da própria dashboard da OLX também chegam (importadas ao abrir o Rastreazera).
Requer o `server.py` rodando e o Chrome aberto com a extensão. O estado das buscas fica em `ponte_estado.json` (fora do git).
A ponte só aceita chamadas do próprio Rastreazera e de extensões do Chrome.

## Por que um proxy?

O navegador bloqueia (CORS) que um site consulte diretamente o site de outra empresa, como a SPX.
O proxy faz a consulta “do lado do servidor” e devolve o resultado. Ele só aceita as transportadoras
listadas em `UPSTREAMS` e códigos válidos, então não vira um proxy aberto.

## Publicar

### 1. Site no GitHub Pages

```bash
git init
git add .
git commit -m "Rastreazera"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/rastreazera.git
git push -u origin main
```

No GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.

### 2. Proxy no Cloudflare Workers (grátis)

1. Crie uma conta em https://dash.cloudflare.com/sign-up.
2. **Workers & Pages → Create → Create Worker**, dê o nome `rastreazera` e clique em **Deploy**.
3. **Edit code**, apague o conteúdo, cole o `worker.js` e clique em **Deploy**.
4. Copie o endereço (ex.: `https://rastreazera.SEU-USUARIO.workers.dev`).
5. No site publicado: ⚙️ → **Endereço do proxy** → cole → **Salvar proxy** (em cada aparelho).

## Sincronizar computador ↔ celular

1. Crie um token em https://github.com/settings/tokens/new?scopes=gist (apenas o escopo `gist`).
2. No site, ⚙️ → cole o token → **Salvar e sincronizar**. Um Gist secreto é criado e o ID aparece no campo.
3. No outro aparelho, ⚙️ → cole o **mesmo token e o mesmo ID do Gist**.

O token fica salvo só no navegador de cada aparelho.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Estrutura da página e diálogos |
| `app.js` | Lógica: cadastro, lista, filtros, resultado do rastreio, backup |
| `carriers.js` | Transportadoras: padrões de código e links de rastreio |
| `trackers.js` | Consulta automática (Shopee Xpress) via proxy |
| `coletor/` | Extensão Rastreazera Coletor (busca a cada 1 h) + `coletores.js` (usados também pelo favorito e pelo agente) |
| `.claude/skills/importar-pedidos/` | Agente `/importar-pedidos` do Claude Code |
| `server.py` | Servidor local + proxy |
| `worker.js` | Proxy para produção (Cloudflare Workers) |
| `sync.js` | Sincronização via GitHub Gist |
| `styles.css` | Visual (tema claro/escuro automático) |
| `sw.js`, `manifest.webmanifest` | App instalável e offline (PWA) |
