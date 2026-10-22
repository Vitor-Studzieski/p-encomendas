-- Allow an authenticated dashboard operator to clear all current and historical orders.
-- Keep sequential order-code counters and reservations so old WhatsApp codes are never reused.

begin;

create or replace function public.dashboard_clear_all_orders()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fk record;
  v_relation regclass;
  v_deleted_orders bigint := 0;
  v_deleted_items bigint := 0;
  v_deleted_audit bigint := 0;
  v_deleted_agenda bigint := 0;
  v_deleted_runs bigint := 0;
begin
  if pg_catalog.to_regclass('public.orders') is null then
    raise exception using errcode = '42P01', message = 'A tabela public.orders não existe.';
  end if;

  create temporary table dashboard_clear_order_targets (
    order_id text not null,
    order_ref text not null
  ) on commit drop;

  insert into pg_temp.dashboard_clear_order_targets (order_id, order_ref)
  select orders.id::text, orders.id::text
  from public.orders as orders;

  insert into pg_temp.dashboard_clear_order_targets (order_id, order_ref)
  select orders.id::text, orders.external_order_id::text
  from public.orders as orders
  where nullif(pg_catalog.btrim(orders.external_order_id::text), '') is not null;

  insert into pg_temp.dashboard_clear_order_targets (order_id, order_ref)
  select view_orders.id::text, view_orders.display_id::text
  from public.dashboard_orders as view_orders
  where nullif(pg_catalog.btrim(view_orders.display_id::text), '') is not null;

  -- Audit entries only describe order workflow and are part of the requested history reset.
  v_relation := pg_catalog.to_regclass('public.dashboard_automation_audit');
  if v_relation is not null then
    execute 'delete from public.dashboard_automation_audit';
    get diagnostics v_deleted_audit = row_count;
  end if;

  -- Production agenda rows are all generated from orders; remove stale rows too.
  v_relation := pg_catalog.to_regclass('public.production_agenda');
  if v_relation is not null then
    execute 'delete from public.production_agenda';
    get diagnostics v_deleted_agenda = row_count;
  end if;

  -- Remove scheduled order workflows whose references point to an order being cleared.
  v_relation := pg_catalog.to_regclass('public.dashboard_automation_runs');
  if v_relation is not null then
    execute 'delete from public.dashboard_automation_runs as runs
      where runs.reference::text in (select targets.order_ref from pg_temp.dashboard_clear_order_targets as targets)';
    get diagnostics v_deleted_runs = row_count;
  end if;

  -- Also clean the known item table if an older schema lacks its foreign-key constraint.
  v_relation := pg_catalog.to_regclass('public.order_items');
  if v_relation is not null then
    execute 'delete from public.order_items as items using public.orders as orders where items.order_id = orders.id';
    get diagnostics v_deleted_items = row_count;
  end if;

  -- Delete every direct table dependency before the parent orders, including order items.
  for v_fk in
    select child_namespace.nspname as child_schema,
           child_table.relname as child_table,
           pg_catalog.string_agg(
             pg_catalog.format('child.%I = parent.%I', child_column.attname, parent_column.attname),
             ' and ' order by child_key.ordinality
           ) as join_condition
    from pg_catalog.pg_constraint as constraint_row
    join pg_catalog.pg_class as child_table on child_table.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace as child_namespace on child_namespace.oid = child_table.relnamespace
    cross join lateral pg_catalog.unnest(constraint_row.conkey) with ordinality as child_key(attnum, ordinality)
    cross join lateral pg_catalog.unnest(constraint_row.confkey) with ordinality as parent_key(attnum, ordinality)
    join pg_catalog.pg_attribute as child_column
      on child_column.attrelid = child_table.oid and child_column.attnum = child_key.attnum
    join pg_catalog.pg_attribute as parent_column
      on parent_column.attrelid = constraint_row.confrelid
     and parent_column.attnum = parent_key.attnum
     and parent_key.ordinality = child_key.ordinality
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.orders'::pg_catalog.regclass
      and constraint_row.conrelid <> 'public.orders'::pg_catalog.regclass
    group by child_namespace.nspname, child_table.relname, constraint_row.oid
  loop
    execute pg_catalog.format(
      'delete from %I.%I as child using public.orders as parent where %s',
      v_fk.child_schema,
      v_fk.child_table,
      v_fk.join_condition
    );
  end loop;

  delete from public.orders;
  get diagnostics v_deleted_orders = row_count;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'deleted_orders', v_deleted_orders,
    'deleted_order_items', v_deleted_items,
    'deleted_audit_entries', v_deleted_audit,
    'deleted_agenda_rows', v_deleted_agenda,
    'deleted_automation_runs', v_deleted_runs
  );
end;
$$;

revoke all on function public.dashboard_clear_all_orders() from public, anon, authenticated;
grant execute on function public.dashboard_clear_all_orders() to service_role;

notify pgrst, 'reload schema';

-- The destructive purge is invoked only from the explicit dashboard action.
-- Never call dashboard_clear_all_orders() automatically from a migration.

commit;
