---
name: importar-pedidos
description: Coleta os pedidos a caminho das contas Shopee, AliExpress e OLX (Verificação Completa da extensão OLX Dashboard) do usuário e cadastra (ou atualiza) os rastreios no Rastreazera. Use quando o usuário pedir para importar, puxar, buscar, sincronizar ou atualizar pedidos. Argumento opcional: "shopee", "aliexpress" ou "olx" (padrão: todas).
---

# Importar pedidos para o Rastreazera

Agente que lê os pedidos das contas **já logadas no navegador embutido** (painel Browser do app)
e cadastra no Rastreazera. Usa os mesmos coletores do favorito "Importar pedidos" e da extensão Rastreazera Coletor: `coletor/coletores.js`.
Reimportar também **atualiza** pacotes já cadastrados (último evento, histórico, status, previsão).

| Loja | Página de pedidos | Função do coletor |
|---|---|---|
| Shopee | `https://shopee.com.br/user/purchase/` | `coletarPedidosShopee()` |
| AliExpress | `https://www.aliexpress.com/p/order/index.html` | `coletarPedidosAliExpress()` |

## Regras

- **Somente leitura nas lojas.** Nunca clicar em "Pedido Recebido"/"Confirmar entrega", cancelar, excluir,
  avaliar, conversar, comprar ou qualquer ação que altere a conta. Apenas navegar e executar o coletor.
- **Nunca digitar senha nem resolver captcha.** Se a loja pedir login ou verificação, pedir ao usuário
  que faça isso no painel do navegador (Ctrl+Shift+B para mostrar o painel) e esperar a confirmação.
- **Não apagar os dados do Rastreazera no painel** (`localStorage`): são os dados reais do usuário.
- Não exibir dados pessoais além do necessário (produto, loja, código de rastreio).

## Lojas desmarcadas

Antes de buscar, leia `GET /api/config` → `lojas` (ex.: `{"shopee": true, "aliexpress": true, "olx": false}`).
**Não busque lojas desmarcadas** (o usuário as tirou em ⚙️ → Onde buscar pedidos), a menos que ele peça
explicitamente aquela loja agora. Só passe as marcadas para `Rastreazera.iniciarBusca([...])`.

## Caminho rápido (extensão Rastreazera Coletor instalada no Chrome)

A extensão `coletor/` já busca as três lojas sozinha a cada 1 hora. Para buscar agora: na aba do
Rastreazera, clique em `#btnBuscar` e acompanhe `#olxStatus` ("Buscando pedidos: Shopee ✅ · AliExpress ✅ ·
OLX 🔄 (...)") até sumir; o resumo fica em `localStorage['rastreazera:notificacoes'][0].texto`.
Se em ~2,5 min aparecer a notificação "Busca não começou", a extensão não está rodando: use os passos abaixo
(coleta pelo navegador embutido).

## Passos (coleta pelo navegador embutido)

1. **Servidor local**: `preview_start` com `name: "rastreazera"` (reutiliza se já estiver rodando).
   Anote o `tabId` do Rastreazera (origem `http://localhost:5500`).
2. **Abrir a busca** na aba do Rastreazera, com as lojas que vai consultar (padrão: as três):
   `Rastreazera.iniciarBusca(['shopee', 'aliexpress', 'olx'])`.
   Assim o sininho 🔔 recebe **uma** notificação no fim, por exemplo:
   "3 pedidos Shopee (1 novo) · 2 pedidos AliExpress (sem novidades) · 1 pedido OLX (1 novo)".
3. **OLX primeiro** (é a mais demorada): na aba do Rastreazera, peça a **Verificação Completa** da
   extensão *OLX Dashboard* (roda no Chrome do usuário, não no navegador embutido):
   `await fetch('/api/olx/solicitar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })`.
   Ela entra em cada conta OLX cadastrada e devolve os pedidos; o `server.py` transforma o resultado numa
   busca "só OLX" que o app importa sozinho (em até 1 min) dentro da busca aberta no passo 2.
   Acompanhe em `GET /api/olx/estado` (`progresso.contas`); pode levar minutos. Se `solicitadoEm` continuar
   lá depois de ~3 min, a extensão OLX não está rodando: `Rastreazera.registrarFalhaBusca('olx', 'extensão OLX não respondeu')`.
4. Enquanto a OLX roda, para **Shopee** e **AliExpress**:
   1. Abra a página de pedidos em outra aba (`preview_start` com `url`) e espere ~4 s.
   2. Confira `location.href` com `javascript_tool`. Se caiu em login/verificação, peça ao usuário
      para entrar e pare até ele confirmar. Se ele não puder agora, registre a falha:
      `Rastreazera.registrarFalhaBusca('shopee', 'não está logado')` (na aba do Rastreazera).
   3. Leia `coletor/coletores.js` e execute na aba da loja com `javascript_tool`:
      o conteúdo do arquivo seguido de `\nawait coletarPedidos()`.
      O resultado é `{ fonte, pedidos: [...] }`. Erro "verifique se está logado" → passo 4.2.
   4. Na aba do Rastreazera, execute com `javascript_tool`:
      `location.hash = 'importar=' + encodeURIComponent(JSON.stringify(<RESULTADO>))`.
      O `#toast` mostra o parcial (ex.: "3 pedidos Shopee (sem novidades) — aguardando AliExpress, OLX").
5. **Fim**: quando a última loja terminar, a notificação da busca aparece no 🔔 (e no `#toast`).
   Confira em `localStorage['rastreazera:notificacoes'][0].texto`. Se algo travar, feche a busca
   com `Rastreazera.finalizarBusca()` (lojas sem resposta aparecem como "não terminou").
6. **Relatar** ao usuário o texto da notificação e o que mudou (novos pacotes, status atualizados).
## Se um coletor quebrar

As lojas podem mudar as APIs internas. Inspecione com `read_network_requests` na página de pedidos.

- **Shopee** (fetch na mesma origem, com cookies):
  `/api/v4/order/get_all_order_and_checkout_list?limit=20&offset=N` → `new_data.order_or_checkout_data[].order_list_detail`;
  `/api/v4/order/get_order_detail?order_id=ID` → `data.shipping.tracking_number`.
- **AliExpress** (via `window.lib.mtop.request`, que a página carrega e que assina as chamadas):
  `mtop.aliexpress.trade.buyer.order.list` com `statusTab` `processing`/`shipped` → chaves `pc_om_list_order_*`;
  `mtop.ae.ld.querydetail` com `tradeOrderId` → `module.trackingDetailLineList[]` (`mailNo`, `detailList`, `etaInfo`).
