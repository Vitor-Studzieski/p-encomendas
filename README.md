# Gestão de Encomendas

Dashboard local da operação da padaria. Ela não usa pedidos fictícios e não guarda credenciais do Supabase nem da Z-API no navegador.

## Abrir

Na pasta do projeto, execute:

```powershell
.\work\dashboard\start-dashboard.ps1
```

Abra `http://127.0.0.1:8766/`. Para encerrar o servidor local:

```powershell
.\work\dashboard\stop-dashboard.ps1
```

O servidor escuta somente em `127.0.0.1` e encaminha as chamadas `/api/*` ao n8n local em `127.0.0.1:5678`.

## Acesso da API

Use **Conectar** e informe o token do webhook protegido do n8n. A dashboard envia o valor em `x-dashboard-token` e o mantém apenas no `sessionStorage` da aba atual. **Desconectar** apaga o token.

Não grave chaves `service_role`, tokens Z-API nem tokens de webhook em `config.js`.

## Rotas que a dashboard espera no workflow original

| Dashboard local | Webhook n8n | Método |
| --- | --- | --- |
| `/api/orders` | `/webhook/dashboard/orders` | GET |
| `/api/settings` | `/webhook/dashboard/settings` | GET e PUT |
| `/api/order-actions` | `/webhook/dashboard/order-actions` | POST |
| `/api/orders/create` | `/webhook/dashboard/orders/create` | POST |

O servidor local apenas encaminha essas rotas. Elas ainda precisam existir no workflow original, exigir autenticação, validar os dados e usar credenciais mantidas no n8n.

## Estado de integração observado em 02/10/2026

- A dashboard local está servindo e não mostra pedidos fictícios. As telas de configuração, pedidos e histórico aguardam acesso real.
- Foi criada no projeto n8n a tabela interna `dashboard_operation_settings`, com um registro único para os contatos. O rascunho do workflow agora liga `GET /dashboard/settings` à leitura dessa tabela e inclui `PUT /dashboard/settings` protegido por `Header Auth account 2`, com validação e gravação dos três telefones. Essas mudanças ainda precisam ser publicadas para ficarem ativas. As rotas de pedidos, histórico e ações ainda não existem.
- O node `CONFIG | Carregar parâmetros` aponta para um projeto Supabase cujo ref não aparece na conta Supabase conectada a esta sessão. O projeto chamado **Ordem de Serviço** aparece inativo e tem outro ref. Por isso, a conexão e o esquema de produção ainda não puderam ser confirmados.
- O host Cloudflare gravado em `work/cloudflare/running-processes.json` é diferente do host que o n8n mostra para a URL de teste do novo gatilho. A dashboard local fala com o n8n pelo endereço local; os webhooks externos da Z-API ainda precisam do `WEBHOOK_URL` alinhado ao túnel em uso.
- A configuração do workflow ainda mantém valores da Z-API em texto no node de código; o destino da padaria continua como placeholder e o campo de token de cliente da Z-API está vazio. Não envie mensagens de produção até mover os segredos para credenciais do n8n e cadastrar o telefone pela dashboard.
- A versão publicada do workflow continua ativa; as mudanças da integração de contatos estão no rascunho e ainda não foram publicadas.

## O que falta

1. Conectar o projeto Supabase correto (`ztwrqyvamsgzrpidhide`) à integração Supabase desta sessão ou confirmar que o projeto correto é outro. O projeto `Ordem de Serviço` atualmente aparece inativo e não corresponde ao ref usado pelo workflow.
2. Rodar a consulta somente de leitura em [`NECESSARIO-SUPABASE.sql`](../../work/dashboard/NECESSARIO-SUPABASE.sql) no projeto correto e compartilhar o resultado CSV. Ela lista apenas colunas e assinaturas de funções, sem ler dados de clientes.
3. Com o esquema confirmado, montar as rotas de pedidos, histórico e ações no workflow original, apontando a leitura/escrita às estruturas corretas. As mudanças ficam em rascunho até serem revisadas.
4. Alinhar o `WEBHOOK_URL` do n8n ao host atual do Cloudflare e atualizar as URLs de formulários/webhooks que dependem do túnel.
5. Guardar os segredos Z-API em credenciais do n8n; depois de publicar o workflow, cadastrar os números da padaria, da fiscal e o telefone padrão do cliente na tela **Configurações**.
6. Publicar o workflow somente depois da confirmação final.

## Formatos de resposta

`GET /api/settings` deve devolver `{ "data": { "bakery_phone_e164": "+55...", "fiscal_phone_e164": "+55...", "customer_phone_e164": "+55..." } }`. `PUT /api/settings` recebe esses mesmos três campos; o telefone do cliente também preenche o formulário de novo pedido como padrão e pode ser alterado por pedido.

`GET /api/orders` deve devolver `{ "data": [pedido, ...] }` ou `{ "orders": [pedido, ...] }`. As ações e novos pedidos devem entrar pelo workflow original para manter situação, histórico e notificações sincronizados.
