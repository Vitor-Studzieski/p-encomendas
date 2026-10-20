-- Dashboard runtime settings and idempotency for scheduled messages.
-- Existing order data is preserved; public access to operational tables/functions is restricted.

begin;

-- Remove the historical n8n names without losing the transactional rules or audit history.
-- Function OIDs stay the same, so existing dependencies such as triggers remain attached.
do $$
declare
  v_routine record;
  v_new_name text;
  v_definition text;
begin
  if to_regclass('public.n8n_automation_audit') is not null then
    if to_regclass('public.dashboard_automation_audit') is not null then
      raise exception 'Both audit tables exist; merge their records before applying this migration.';
    end if;
    alter table public.n8n_automation_audit rename to dashboard_automation_audit;
  end if;

  for v_routine in
    select p.oid, p.proname, p.prokind, p.proargtypes,
           pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and left(p.proname, 4) = 'n8n_'
  loop
    v_new_name := 'dashboard_' || substring(v_routine.proname from 5);

    if exists (
      select 1
      from pg_catalog.pg_proc existing
      where existing.pronamespace = 'public'::regnamespace
        and existing.proname = v_new_name
        and existing.proargtypes = v_routine.proargtypes
    ) then
      raise exception 'Cannot rename public.%: public.% with the same signature already exists.',
        v_routine.proname, v_new_name;
    end if;

    execute pg_catalog.format(
      'alter %s %I.%I(%s) rename to %I',
      case when v_routine.prokind = 'p' then 'procedure' else 'function' end,
      'public', v_routine.proname, v_routine.identity_arguments, v_new_name
    );
  end loop;

  -- Rewrite references inside the renamed routines and any public helper routine
  -- that called them, keeping the original transaction behavior.
  for v_routine in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and pg_catalog.strpos(pg_catalog.pg_get_functiondef(p.oid), 'n8n_') > 0
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_routine.oid);
    v_definition := replace(v_definition, 'n8n_', 'dashboard_');
    execute v_definition;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and (left(p.proname, 4) = 'n8n_' or pg_catalog.strpos(pg_catalog.pg_get_functiondef(p.oid), 'n8n_') > 0)
  ) then
    raise exception 'Public routines still reference legacy n8n names; transaction cancelled.';
  end if;
end;
$$;

create table if not exists public.dashboard_operation_settings (
  setting_key text primary key check (setting_key = 'operation'),
  bakery_phone_e164 text not null default '',
  fiscal_phone_e164 text not null default '',
  customer_phone_e164 text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.dashboard_operation_settings
  add column if not exists customer_phone_e164 text not null default '';

alter table public.dashboard_operation_settings enable row level security;
revoke all on table public.dashboard_operation_settings from public, anon, authenticated;
grant select, insert, update on table public.dashboard_operation_settings to service_role;

insert into public.dashboard_operation_settings (setting_key)
values ('operation')
on conflict (setting_key) do nothing;

create table if not exists public.dashboard_automation_runs (
  job_key text primary key,
  job_type text not null,
  reference text not null,
  status text not null check (status in ('started', 'scheduled', 'sent', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  details jsonb not null default '{}'::jsonb
);

create index if not exists dashboard_automation_runs_started_at_idx
  on public.dashboard_automation_runs (started_at desc);

alter table public.dashboard_automation_runs enable row level security;
revoke all on table public.dashboard_automation_runs from public, anon, authenticated;
grant select, insert, update on table public.dashboard_automation_runs to service_role;

-- The browser never uses Supabase directly. Keep operational records server-only.
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

revoke all on table public.customers from public, anon, authenticated;
revoke all on table public.orders from public, anon, authenticated;
revoke all on table public.order_items from public, anon, authenticated;
grant select, insert, update on table public.customers to service_role;
grant select, insert, update on table public.orders to service_role;
grant select, insert, update on table public.order_items to service_role;

do $$
begin
  if to_regclass('public.dashboard_automation_audit') is not null then
    alter table public.dashboard_automation_audit enable row level security;
    revoke all on table public.dashboard_automation_audit from public, anon, authenticated;
    grant insert on table public.dashboard_automation_audit to service_role;
  end if;
end;
$$;

alter view public.dashboard_orders set (security_invoker = true);
revoke all on table public.dashboard_orders from public, anon, authenticated;
grant select on table public.dashboard_orders to service_role;

-- Functions in public are executable by PUBLIC unless privileges are narrowed explicitly.
do $$
declare
  v_routine record;
begin
  for v_routine in
    select p.oid, p.proname, p.prokind,
           pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and left(p.proname, 10) = 'dashboard_'
  loop
    execute pg_catalog.format(
      'revoke all on %s %I.%I(%s) from public, anon, authenticated',
      case when v_routine.prokind = 'p' then 'procedure' else 'function' end,
      'public', v_routine.proname, v_routine.identity_arguments
    );
    execute pg_catalog.format(
      'grant execute on %s %I.%I(%s) to service_role',
      case when v_routine.prokind = 'p' then 'procedure' else 'function' end,
      'public', v_routine.proname, v_routine.identity_arguments
    );
  end loop;
end;
$$;

create or replace function public.claim_dashboard_automation(
  p_job_key text,
  p_job_type text,
  p_reference text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claimed text;
begin
  insert into public.dashboard_automation_runs (
    job_key, job_type, reference, status, started_at, completed_at, details
  ) values (
    p_job_key, p_job_type, p_reference, 'started', now(), null, '{}'::jsonb
  )
  on conflict (job_key) do update
    set job_type = excluded.job_type,
        reference = excluded.reference,
        status = 'started',
        started_at = now(),
        completed_at = null,
        details = '{}'::jsonb
    where public.dashboard_automation_runs.status = 'failed'
       or (public.dashboard_automation_runs.status = 'started'
           and public.dashboard_automation_runs.started_at < now() - interval '15 minutes')
  returning job_key into v_claimed;

  return v_claimed is not null;
end;
$$;

revoke all on function public.claim_dashboard_automation(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_dashboard_automation(text, text, text) to service_role;

-- Store only keyed fingerprints for abuse protection. Raw IP addresses are never persisted.
create schema if not exists dashboard_private;
revoke all on schema dashboard_private from public, anon, authenticated;
grant usage on schema dashboard_private to service_role;

create table if not exists dashboard_private.rate_limits (
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope ~ '^[a-z0-9-]{1,64}$'),
  window_started_at timestamptz not null,
  hit_count integer not null check (hit_count > 0),
  updated_at timestamptz not null default now(),
  primary key (fingerprint, scope)
);

create index if not exists dashboard_rate_limits_updated_at_idx
  on dashboard_private.rate_limits (updated_at);

alter table dashboard_private.rate_limits enable row level security;
revoke all on table dashboard_private.rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table dashboard_private.rate_limits to service_role;

create or replace function public.consume_dashboard_rate_limit(
  p_fingerprint text,
  p_scope text,
  p_max_hits integer,
  p_window_seconds integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window interval;
  v_started_at timestamptz;
  v_hit_count integer;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
     or p_scope is null or p_scope !~ '^[a-z0-9-]{1,64}$'
     or p_max_hits is null or p_max_hits < 1 or p_max_hits > 10000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception using errcode = '22023', message = 'Invalid rate limit input';
  end if;

  v_window := pg_catalog.make_interval(secs => p_window_seconds);
  insert into dashboard_private.rate_limits (
    fingerprint, scope, window_started_at, hit_count, updated_at
  ) values (
    p_fingerprint, p_scope, v_now, 1, v_now
  )
  on conflict (fingerprint, scope) do update
    set window_started_at = case
          when dashboard_private.rate_limits.window_started_at <= v_now - v_window then v_now
          else dashboard_private.rate_limits.window_started_at
        end,
        hit_count = case
          when dashboard_private.rate_limits.window_started_at <= v_now - v_window then 1
          else dashboard_private.rate_limits.hit_count + 1
        end,
        updated_at = v_now
  returning window_started_at, hit_count into v_started_at, v_hit_count;

  return query select
    v_hit_count <= p_max_hits,
    greatest(1, ceil(extract(epoch from (v_started_at + v_window - v_now)))::integer);

  if pg_catalog.random() < 0.01 then
    delete from dashboard_private.rate_limits
    where updated_at < v_now - interval '7 days';
  end if;
end;
$$;

revoke all on function public.consume_dashboard_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_dashboard_rate_limit(text, text, integer, integer) to service_role;

notify pgrst, 'reload schema';

commit;

