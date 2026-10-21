-- Diagnóstico somente leitura das RPCs transacionais e dependências.
-- Execute tudo no Supabase SQL Editor e envie a tabela de resultados.
-- Não cria, altera nem envia pedidos.

with expected_rpc(routine_name, signature, expected_arg_names) as (
  values
    (
      'dashboard_process_event',
      'public.dashboard_process_event(text,text,text,jsonb)',
      array['p_event_id', 'p_event_type', 'p_order_ref', 'p_payload']::text[]
    ),
    (
      'dashboard_order_readiness',
      'public.dashboard_order_readiness(text)',
      array['p_order_id']::text[]
    ),
    (
      'dashboard_upsert_production_agenda',
      'public.dashboard_upsert_production_agenda(text,jsonb,timestamp with time zone,timestamp with time zone)',
      array['p_order_ref', 'p_sector', 'p_planned_start_at', 'p_due_at']::text[]
    )
),
rpc_rows as (
  select
    'RPC'::text as categoria,
    e.routine_name as objeto,
    e.signature as assinatura_esperada,
    case
      when p.oid is null then 'AUSENTE: assinatura esperada não encontrada'
      when p.prokind <> 'f' then 'ERRO: objeto encontrado não é função'
      when p.proargnames[1:p.pronargs] is distinct from e.expected_arg_names then 'ERRO: nomes dos parâmetros não correspondem ao PostgREST'
      when not has_function_privilege('service_role', p.oid, 'EXECUTE') then 'ERRO: service_role sem EXECUTE'
      when has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'ATENÇÃO: execução permitida a anon/authenticated'
      else 'OK: assinatura e permissões'
    end as status,
    coalesce(pg_catalog.pg_get_function_identity_arguments(p.oid), '(ausente)') as assinatura_encontrada,
    pg_catalog.pg_get_function_result(p.oid) as retorno,
    l.lanname as linguagem,
    case when p.prosecdef then 'DEFINER' else 'INVOKER' end as seguranca,
    coalesce(array_to_string(p.proconfig, ', '), '(padrão do banco)') as search_path,
    case when p.oid is null then null else has_function_privilege('service_role', p.oid, 'EXECUTE') end as service_role_execute,
    case when p.oid is null then null else has_function_privilege('anon', p.oid, 'EXECUTE') end as anon_execute,
    case when p.oid is null then null else has_function_privilege('authenticated', p.oid, 'EXECUTE') end as authenticated_execute,
    coalesce(overloads.signatures, '(nenhuma)') as assinaturas_com_esse_nome,
    case
      when p.oid is null then null
      else pg_catalog.strpos(pg_catalog.pg_get_functiondef(p.oid), 'n8n_') > 0
    end as referencia_nome_antigo_n8n,
    case
      when e.routine_name <> 'dashboard_process_event' or p.oid is null then null
      else pg_catalog.strpos(pg_catalog.pg_get_functiondef(p.oid), 'product_size_id') > 0
    end as processo_le_product_size_id,
    null::text as detalhe
  from expected_rpc e
  left join pg_catalog.pg_proc p
    on p.oid = pg_catalog.to_regprocedure(e.signature)
  left join pg_catalog.pg_language l on l.oid = p.prolang
  left join lateral (
    select pg_catalog.string_agg(
      pg_catalog.format('%I(%s)', p2.proname, pg_catalog.pg_get_function_identity_arguments(p2.oid)),
      '; ' order by pg_catalog.pg_get_function_identity_arguments(p2.oid)
    ) as signatures
    from pg_catalog.pg_proc p2
    join pg_catalog.pg_namespace n2 on n2.oid = p2.pronamespace
    where n2.nspname = 'public'
      and p2.proname = e.routine_name
  ) overloads on true
),
expected_helpers(routine_name, signature) as (
  values
    ('dashboard_normalize_phone', 'private.dashboard_normalize_phone(text)'),
    ('dashboard_parse_date', 'private.dashboard_parse_date(text)'),
    ('dashboard_parse_time', 'private.dashboard_parse_time(text)'),
    ('dashboard_resolve_order', 'private.dashboard_resolve_order(text)'),
    ('dashboard_resolve_product', 'private.dashboard_resolve_product(jsonb)'),
    ('dashboard_resolve_sector', 'private.dashboard_resolve_sector(jsonb,uuid)')
),
helper_rows as (
  select
    'HELPER'::text as categoria,
    e.routine_name as objeto,
    e.signature as assinatura_esperada,
    case
      when p.oid is null then 'AUSENTE: dependência do processamento de pedidos'
      when p.prokind <> 'f' then 'ERRO: objeto encontrado não é função'
      when not has_function_privilege('service_role', p.oid, 'EXECUTE') then 'ERRO: service_role sem EXECUTE'
      when has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'ATENÇÃO: execução permitida a anon/authenticated'
      else 'OK: presente e acessível ao service_role'
    end as status,
    coalesce(pg_catalog.pg_get_function_identity_arguments(p.oid), '(ausente)') as assinatura_encontrada,
    pg_catalog.pg_get_function_result(p.oid) as retorno,
    l.lanname as linguagem,
    case when p.prosecdef then 'DEFINER' else 'INVOKER' end as seguranca,
    coalesce(array_to_string(p.proconfig, ', '), '(padrão do banco)') as search_path,
    case when p.oid is null then null else has_function_privilege('service_role', p.oid, 'EXECUTE') end as service_role_execute,
    case when p.oid is null then null else has_function_privilege('anon', p.oid, 'EXECUTE') end as anon_execute,
    case when p.oid is null then null else has_function_privilege('authenticated', p.oid, 'EXECUTE') end as authenticated_execute,
    null::text as assinaturas_com_esse_nome,
    null::boolean as referencia_nome_antigo_n8n,
    null::boolean as processo_le_product_size_id,
    null::text as detalhe
  from expected_helpers e
  left join pg_catalog.pg_proc p
    on p.oid = pg_catalog.to_regprocedure(e.signature)
  left join pg_catalog.pg_language l on l.oid = p.prolang
),
schema_checks as (
  select
    'ESTRUTURA'::text as categoria,
    c.objeto,
    c.assinatura_esperada,
    case when c.ok then 'OK' else 'ERRO: ' || c.falha end as status,
    null::text as assinatura_encontrada,
    null::text as retorno,
    null::text as linguagem,
    null::text as seguranca,
    null::text as search_path,
    null::boolean as service_role_execute,
    null::boolean as anon_execute,
    null::boolean as authenticated_execute,
    null::text as assinaturas_com_esse_nome,
    null::boolean as referencia_nome_antigo_n8n,
    null::boolean as processo_le_product_size_id,
    c.detalhe
  from (
    select
      'order_items.product_size_id'::text as objeto,
      'public.order_items(product_size_id)'::text as assinatura_esperada,
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'order_items' and column_name = 'product_size_id'
      ) as ok,
      'a coluna public.order_items.product_size_id não existe'::text as falha,
      'A RPC precisa guardar o identificador do tamanho selecionado.'::text as detalhe
    union all
    select
      'order_items_product_size_fkey',
      'FK (product_id, product_size_id) -> product_sizes (product_id, id)',
      exists (
        select 1 from pg_catalog.pg_constraint c
        where c.conrelid = pg_catalog.to_regclass('public.order_items')
          and c.conname = 'order_items_product_size_fkey'
          and c.contype = 'f'
          and c.convalidated
      ),
      'a FK esperada está ausente ou não validada',
      'Confere se o tamanho pertence ao mesmo produto.'
    union all
    select
      'product_sizes_product_id_id_key',
      'UNIQUE (product_id, id) em public.product_sizes',
      exists (
        select 1 from pg_catalog.pg_constraint c
        where c.conrelid = pg_catalog.to_regclass('public.product_sizes')
          and c.conname = 'product_sizes_product_id_id_key'
          and c.contype = 'u'
          and c.convalidated
      ),
      'a chave única esperada está ausente ou não validada',
      'Necessária para a FK composta que valida produto e tamanho.'
    union all
    select
      'validate_order_item_size trigger',
      'trigger ativo em public.order_items',
      exists (
        select 1
        from pg_catalog.pg_trigger t
        join pg_catalog.pg_proc p on p.oid = t.tgfoid
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where t.tgrelid = pg_catalog.to_regclass('public.order_items')
          and not t.tgisinternal
          and t.tgenabled <> 'D'
          and n.nspname = 'public'
          and p.proname = 'validate_order_item_size'
      ),
      'não há trigger ativo validate_order_item_size em public.order_items',
      'Valida que o tamanho informado existe e está ativo para o produto.'
  ) c
)
select * from rpc_rows
union all
select * from helper_rows
union all
select * from schema_checks
order by categoria, objeto;
