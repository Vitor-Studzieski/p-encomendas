# Dashboard de encomendas

Dashboard e backend em código para pedidos, agenda de produção e notificações por WhatsApp. A aplicação usa Vercel para servir a interface e a API, Supabase para dados e Z-API para mensagens. O runtime não depende de n8n, Docker ou túnel Cloudflare.

## Funcionalidades

- Consulta de pedidos e histórico pela view `public.dashboard_orders`.
- Cadastro dos contatos da padaria, fiscal, Açougue e Frios, além do WhatsApp padrão do cliente.
- Criação de pedidos pela dashboard ou pelo formulário público da fiscal, atribuindo cada item ao seu setor.
- Revisão de impedimentos pela fiscal sem encerrar o pedido; depois da análise, a padaria confirma novamente pelo WhatsApp.
- Encaminhamento de listas separadas para Padaria, Açougue e Frios e andamento individual de cada setor no painel.
- Cada pedido pode envolver um, dois ou os três setores; o painel mostra apenas os envolvidos e reúne as áreas internas da Padaria.
- Registro de problemas de produção, conclusão de todos os setores e confirmação da retirada por eventos idempotentes.
- Avisos de WhatsApp enviados pelo backend à Z-API.
- Webhook de entrada da Z-API: a fiscal recebe o link do formulário; `RECUSAR <id>` pede análise à fiscal e mantém o pedido pendente. Depois da análise, a padaria responde `CONFIRMAR <id>` se puder produzir. Se não puder, a fiscal avisa o cliente e responde `ENCERRAR <id>`.
- Pesquisa de satisfação enviada duas horas após a retirada, com link assinado.
- Resumo de produção diário às 06:00 no horário de São Paulo.
- Limites de tentativas por origem para autenticação, formulário público, pesquisa e callback da Z-API. Os identificadores armazenados no Supabase são HMACs, não endereços IP.

As regras transacionais de pedidos são funções PostgreSQL chamadas pela API: `dashboard_process_event`, `dashboard_upsert_production_agenda` e `dashboard_order_readiness`. A automação de pesquisa usa o Vercel Workflow SDK, sem workflow visual ou serviço n8n.

## Desenvolvimento local

1. Instale Node.js 24 ou mais recente.
2. Copie `.env.example` para `.env.local` e preencha as credenciais localmente.
3. Execute:

   ```powershell
   npm install
   npm run dev
   ```

4. Abra <http://127.0.0.1:8766>.

No primeiro acesso, informe a credencial configurada como `DASHBOARD_ACCESS_TOKEN`. O servidor troca essa credencial por um cookie assinado, `HttpOnly`, `SameSite=Strict` e válido por até 30 dias. Enquanto a dashboard é usada, a validade é renovada automaticamente. A credencial não é guardada no armazenamento do browser. Sessões antigas salvas em `sessionStorage` são migradas uma vez e removidas.

O `.env.local` é ignorado pelo Git intencionalmente: ele contém credenciais e é carregado somente durante o desenvolvimento local. O `.env.example` contém nomes e valores de exemplo, sem chaves reais. A Vercel recebe as variáveis separadamente nas configurações do projeto. `APP_BASE_URL` pode ficar vazio no computador local; no ambiente publicado, informe o domínio HTTPS da produção para gerar links e callbacks públicos.

## Estrutura do projeto

```text
src/
  dashboard/  Inicialização da interface e estilos da operação
    domain/    Normalização e regras de domínio dos pedidos
    ui/        Renderização da lista e da agenda
  forms/      Estilos compartilhados dos formulários públicos
  orders/     Envio do formulário de encomendas
  shared/     Base visual e controles compartilhados
  surveys/    Envio das avaliações
api/          Handlers HTTP usados pelo servidor e pelas rotas Nitro
routes/       Adaptadores de entrada Nitro para os handlers de api/
lib/          Integrações, validação, sessão e acesso ao Supabase/Z-API
workflows/    Tarefas duráveis de satisfação
supabase/     Migrações e consultas operacionais
scripts/      Preparação dos arquivos públicos gerados no build
```

As páginas HTML na raiz são entradas multipágina do Vite. O conteúdo de `public/` é gerado durante o build e fica fora do Git; edite os arquivos fonte em `src/` e as páginas da raiz.

## Supabase

Antes do deploy, abra o **SQL Editor** do projeto Supabase usado pela aplicação e execute, em ordem, `supabase/migrations/20261019000000_dashboard_runtime.sql`, `supabase/migrations/20261020104015_add_department_workflow.sql` e `supabase/migrations/20261020112117_fix_dashboard_phone_normalization.sql`. A primeira migração prepara as tabelas, rotinas e permissões do runtime. A segunda adiciona os contatos de Açougue e Frios e ativa esses setores. A terceira adiciona a normalização E.164 que a rotina de pedidos usa. Se uma migração parar por conflito de nome ou objeto inesperado, revise o erro antes de continuar.

A migração cria e restringe:

- `public.dashboard_operation_settings`, que guarda os telefones da padaria, da fiscal, de Açougue e Frios e o telefone padrão do cliente.
- `public.dashboard_automation_runs`, que impede o envio duplicado de resumos e pesquisas agendadas.
- `public.dashboard_automation_audit`, preservando os registros antigos de auditoria quando a tabela existe.
- `public.claim_dashboard_automation`, uma função de uso interno para reclamar cada tarefa uma única vez.
- Um schema privado para contadores de limitação de tentativas, acessível somente pelo backend.
- RLS e grants de servidor nas tabelas operacionais, e uma view `dashboard_orders` com `security_invoker` sem acesso direto a usuários públicos.
- Execução das RPCs de operação limitada ao papel `service_role`.

A API precisa que o papel `service_role` tenha acesso à view `public.dashboard_orders`, às tabelas operacionais e às RPCs `dashboard_process_event`, `dashboard_upsert_production_agenda`, `dashboard_order_readiness`, `claim_dashboard_automation` e `consume_dashboard_rate_limit`. A chave `SUPABASE_SERVICE_ROLE_KEY` só é usada no servidor; não a coloque em `config.js` nem em variável com prefixo `VITE_`.

## Variáveis de ambiente

Configure em **Vercel → Project → Settings → Environment Variables** para Production e Preview. Para desenvolvimento local, use `.env.local`.

| Variável | Uso |
| --- | --- |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave de serviço, somente server-side |
| `DASHBOARD_ACCESS_TOKEN` | Credencial usada no primeiro acesso à dashboard; mínimo de 32 caracteres |
| `APP_BASE_URL` | Domínio público da dashboard, sem `/` no fim |
| `ZAPI_INSTANCE_ID` | ID da instância Z-API |
| `ZAPI_INSTANCE_TOKEN` | Token da instância Z-API |
| `ZAPI_CLIENT_TOKEN` | Token de segurança da conta Z-API |
| `ZAPI_WEBHOOK_SECRET` | Segredo usado no caminho de callback da Z-API |
| `PUBLIC_ORDER_FORM_TOKEN` | Segredo do link público enviado à fiscal |
| `SURVEY_SIGNING_SECRET` | Segredo para assinar os links de avaliação |
| `CRON_SECRET` | Segredo do endpoint de resumo diário |

Use segredos independentes com pelo menos 32 caracteres para dashboard, webhook, formulário, pesquisa e cron. Não reutilize tokens expostos em telas ou arquivos antigos. Os links da fiscal são assinados, expiram em sete dias e carregam o token no fragmento da URL, que não é enviado ao servidor nos pedidos HTTP; quando ela manda outra mensagem à operação, recebe um link renovado. A avaliação também usa fragmento para não expor sua assinatura nos logs HTTP.

Depois do deploy, configure **Webhooks → Ao receber** na Z-API com esta URL:

```text
https://SEU-DOMINIO/api/zapi/inbound/VALOR_DE_ZAPI_WEBHOOK_SECRET
```

A fiscal recebe um endereço como `https://SEU-DOMINIO/pedido.html#acesso=ASSINATURA&expira=VALIDADE`. Em **Telefones da operação**, cadastre os contatos da equipe. Os números de Açougue e Frios habilitam o envio individual desses setores. Depois de avisar o cliente que um pedido não poderá ser atendido, a fiscal pode encerrá-lo respondendo `ENCERRAR <id>`.

## API

| Rota | Uso |
| --- | --- |
| `GET /api/auth/session`, `POST /api/auth/session`, `DELETE /api/auth/session` | Verifica, inicia e encerra a sessão segura da dashboard |
| `GET /api/orders` | Lista pedidos |
| `GET /api/settings`, `PUT /api/settings` | Lê e grava os contatos da operação |
| `POST /api/order-actions` | Converte ações da dashboard em eventos |
| `GET /api/production-agenda` | Lista as tarefas e o andamento de cada setor; exige sessão |
| `GET /api/public/sectors` | Lista setores ativos para atribuir itens a um pedido |
| `POST /api/orders/create` | Cria pedido pela dashboard |
| `POST /api/events` | Processa evento autenticado |
| `POST /api/zapi/inbound/:secret` | Recebe mensagens da Z-API |
| `POST /api/public/orders` | Recebe formulário da fiscal |
| `POST /api/public/survey` | Grava avaliação assinada |
| `GET /api/cron/daily-summary` | Envia o resumo; exige `Authorization: Bearer CRON_SECRET` |

## Proteções incluídas

- Nenhum segredo Supabase/Z-API é enviado ao navegador; o Vite não expõe variáveis de ambiente server-side.
- Respostas JSON não são armazenadas em cache; links públicos não guardam suas assinaturas na query string.
- A dashboard troca a credencial inicial por uma sessão HMAC assinada em cookie `HttpOnly`, `SameSite=Strict` e `Secure` em produção; a sessão expira após 30 dias sem uso e se renova automaticamente durante o uso.
- O início de sessão valida origem, compara a credencial em tempo constante e limita tentativas compartilhando o contador no Supabase.
- Corpos de API exigem JSON e têm limite de tamanho; pedidos e mensagens passam por limites de campos e validação de formato.
- O Supabase bloqueia acesso direto de `anon` e `authenticated` às tabelas operacionais e às RPCs de negócio. O backend usa a chave de serviço somente na Vercel.
- A Vercel envia CSP, HSTS, `nosniff`, proteção contra framing e uma política de referer restritiva.

## Deploy na Vercel

1. Conecte este repositório a um projeto Vercel.
2. Aplique as duas migrações Supabase na ordem mostrada acima e configure todas as variáveis de ambiente.
3. Configure Node.js 24, habilite **Fluid Compute** e o acesso às variáveis de ambiente do sistema para o Vercel Workflow SDK.
4. Faça o deploy e configure o webhook HTTPS da Z-API.
5. Entre uma vez na dashboard com `DASHBOARD_ACCESS_TOKEN`; a sessão permite cadastrar os contatos de Padaria, Fiscal, Açougue e Frios.

O cron está configurado para 09:00 UTC, equivalente a 06:00 em São Paulo. A plataforma pode iniciar a execução em qualquer momento dentro da hora programada.

Após validar a integração direta da Z-API com a URL da Vercel, remova o webhook antigo e revogue as credenciais antigas do n8n/relay. O endpoint atual é `POST /api/zapi/inbound/:secret`.
