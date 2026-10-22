-- Read-only. Run to capture the current business RPCs and private helpers so
-- their definitions can be added to version-controlled migrations.
select
  n.nspname as schema_name,
  p.proname as routine_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments,
  pg_catalog.pg_get_functiondef(p.oid) as definition
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where (
  n.nspname = 'public'
  and p.proname in (
    'n8n_process_event',
    'n8n_upsert_production_agenda',
    'n8n_order_readiness',
    'n8n_validate_acceptance',
    'dashboard_process_event',
    'dashboard_upsert_production_agenda',
    'dashboard_order_readiness',
    'dashboard_validate_acceptance'
  )
)
or (n.nspname = 'private' and p.proname like 'dashboard_%')
order by p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid);
