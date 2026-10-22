-- Somente leitura. Execute depois de aplicar 20261022103016_atomic_order_event_and_agenda.sql.
-- Confere as assinaturas RPC, privilégios, RLS da caixa de saída e volume por estado.
with expected(name, signature) as (
  values
    ('dashboard_process_event', 'public.dashboard_process_event(text,text,text,jsonb)'),
    ('dashboard_create_order_with_code', 'public.dashboard_create_order_with_code(text,jsonb)'),
    ('dashboard_process_event_with_outbox', 'public.dashboard_process_event_with_outbox(text,text,text,jsonb,jsonb,jsonb)'),
    ('dashboard_create_order_with_code_and_outbox', 'public.dashboard_create_order_with_code_and_outbox(text,jsonb,jsonb)'),
    ('dashboard_enqueue_whatsapp_outbox', 'public.dashboard_enqueue_whatsapp_outbox(text,text,text,jsonb)'),
    ('dashboard_list_whatsapp_outbox_to_publish', 'public.dashboard_list_whatsapp_outbox_to_publish(integer)'),
    ('dashboard_mark_whatsapp_outbox_queued', 'public.dashboard_mark_whatsapp_outbox_queued(uuid)'),
    ('dashboard_claim_whatsapp_outbox', 'public.dashboard_claim_whatsapp_outbox(uuid)'),
    ('dashboard_complete_whatsapp_outbox', 'public.dashboard_complete_whatsapp_outbox(uuid)'),
    ('dashboard_fail_whatsapp_outbox', 'public.dashboard_fail_whatsapp_outbox(uuid,text)')
), routine_checks as (
  select
    'RPC'::text as category,
    e.name as object_name,
    e.signature as expected_signature,
    case
      when p.oid is null then 'MISSING'
      when not has_function_privilege('service_role', p.oid, 'EXECUTE') then 'ERROR: service_role cannot execute'
      when has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'ERROR: public role can execute'
      else 'OK'
    end as status,
    coalesce(pg_catalog.pg_get_function_identity_arguments(p.oid), '(missing)') as actual_signature
  from expected e
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.signature)
), agenda_matches as (
  select p.oid, pg_catalog.pg_get_function_identity_arguments(p.oid) as actual_signature
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'dashboard_upsert_production_agenda'
    and p.prokind = 'f'
    and p.pronargs = 5
    and p.pronargdefaults = 1
    and p.proargnames[1:5] = array[
      'p_order_ref', 'p_sector', 'p_planned_start_at', 'p_due_at', 'p_status'
    ]::text[]
    and p.proargtypes[0] = 'text'::regtype::oid
    and p.proargtypes[1] = 'jsonb'::regtype::oid
    and p.proargtypes[2] = 'timestamp with time zone'::regtype::oid
    and p.proargtypes[3] = 'timestamp with time zone'::regtype::oid
), agenda_check as (
  select
    'RPC'::text as category,
    'dashboard_upsert_production_agenda'::text as object_name,
    'overload de agenda com p_status padrão'::text as expected_signature,
    case
      when count(*) = 0 then 'MISSING'
      when count(*) > 1 then 'ERROR: multiple matching overloads'
      when not bool_and(has_function_privilege('service_role', oid, 'EXECUTE')) then 'ERROR: service_role cannot execute'
      when bool_or(has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE')) then 'ERROR: public role can execute'
      else 'OK'
    end as status,
    coalesce(string_agg(actual_signature, '; '), '(missing)') as actual_signature
  from agenda_matches
), table_check as (
  select
    'TABLE'::text as category,
    'dashboard_whatsapp_outbox'::text as object_name,
    'public.dashboard_whatsapp_outbox'::text as expected_signature,
    case
      when c.oid is null then 'MISSING'
      when not c.relrowsecurity then 'ERROR: RLS disabled'
      when has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
        or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE')
        or has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE') then 'ERROR: public role has table access'
      else 'OK'
    end as status,
    coalesce(c.relrowsecurity::text, 'false') as actual_signature
  from (select pg_catalog.to_regclass('public.dashboard_whatsapp_outbox') as oid) t
  left join pg_catalog.pg_class c on c.oid = t.oid
), outbox_counts as (
  select
    'OUTBOX'::text as category,
    coalesce(o.status, '(empty)') as object_name,
    'rows'::text as expected_signature,
    count(o.id)::text as status,
    coalesce(max(o.updated_at)::text, '(none)') as actual_signature
  from (select pg_catalog.to_regclass('public.dashboard_whatsapp_outbox') as oid) t
  left join public.dashboard_whatsapp_outbox o on t.oid is not null
  where t.oid is not null
  group by o.status
)
select category, object_name, expected_signature, status, actual_signature
from routine_checks
union all
select category, object_name, expected_signature, status, actual_signature
from agenda_check
union all
select category, object_name, expected_signature, status, actual_signature
from table_check
union all
select category, object_name, expected_signature, status, actual_signature
from outbox_counts
order by category, object_name;
