-- Generate stable, human-readable order references inside the database.
-- The code is scoped by São Paulo year and numeric sector code.

begin;

create schema if not exists private;
grant usage on schema private to service_role;

update public.sectors
set active = true,
    sort_order = 50,
    updated_at = pg_catalog.now()
where pg_catalog.lower(pg_catalog.btrim(coalesce(slug, ''))) in ('rotisseria', 'rotisserie')
   or pg_catalog.lower(pg_catalog.btrim(name)) in ('rotisseria', 'rotisserie');

insert into public.sectors (name, slug, active, sort_order)
select 'Rotisseria', 'rotisseria', true, 50
where not exists (
  select 1
  from public.sectors
  where pg_catalog.lower(pg_catalog.btrim(coalesce(slug, ''))) in ('rotisseria', 'rotisserie')
     or pg_catalog.lower(pg_catalog.btrim(name)) in ('rotisseria', 'rotisserie')
);

create table if not exists private.dashboard_sector_order_codes (
  sector_id uuid primary key references public.sectors(id) on delete restrict,
  sector_code smallint not null check (sector_code between 1 and 999)
);

do $$
declare
  v_mapping record;
  v_sector_id uuid;
  v_match_count bigint;
begin
  for v_mapping in
    select * from (values
      (array['padaria', 'paes']::text[], 1::smallint, array['padaria', 'pães']::text[]),
      (array['confeitaria']::text[], 2::smallint, array['confeitaria']::text[]),
      (array['bolo-confeitado']::text[], 2::smallint, array['bolo confeitado']::text[]),
      (array['bolo-seco']::text[], 2::smallint, array['bolo seco']::text[]),
      (array['acougue']::text[], 3::smallint, array['acougue', 'açougue']::text[]),
      (array['frios']::text[], 4::smallint, array['frios']::text[]),
      (array['rotisseria', 'rotisserie']::text[], 5::smallint, array['rotisseria', 'rotisserie']::text[])
    ) as mapping(slugs, sector_code, names)
  loop
    select pg_catalog.count(*)
      into v_match_count
    from public.sectors as s
    where pg_catalog.lower(pg_catalog.btrim(coalesce(s.slug, ''))) = any(v_mapping.slugs)
       or pg_catalog.lower(pg_catalog.btrim(s.name)) = any(v_mapping.names);

    if v_match_count <> 1 then
      raise exception 'Esperava encontrar exatamente um setor para o código %, encontrei %.',
        v_mapping.sector_code, v_match_count;
    end if;

    select s.id
      into v_sector_id
    from public.sectors as s
    where pg_catalog.lower(pg_catalog.btrim(coalesce(s.slug, ''))) = any(v_mapping.slugs)
       or pg_catalog.lower(pg_catalog.btrim(s.name)) = any(v_mapping.names)
    limit 1;

    insert into private.dashboard_sector_order_codes (sector_id, sector_code)
    values (v_sector_id, v_mapping.sector_code)
    on conflict (sector_id) do update
      set sector_code = excluded.sector_code;
  end loop;
end;
$$;

create table if not exists private.dashboard_order_code_counters (
  order_year integer not null check (order_year between 2000 and 9999),
  sector_code smallint not null check (sector_code between 1 and 999),
  last_number bigint not null check (last_number > 0),
  primary key (order_year, sector_code)
);

create table if not exists private.dashboard_order_code_reservations (
  event_id text primary key check (pg_catalog.length(event_id) between 1 and 180),
  sector_id uuid not null references public.sectors(id) on delete restrict,
  order_year integer not null check (order_year between 2000 and 9999),
  sector_code smallint not null check (sector_code between 1 and 999),
  order_number bigint not null check (order_number > 0),
  order_ref text not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  unique (order_year, sector_code, order_number)
);

revoke all on table private.dashboard_sector_order_codes from public, anon, authenticated;
revoke all on table private.dashboard_order_code_counters from public, anon, authenticated;
revoke all on table private.dashboard_order_code_reservations from public, anon, authenticated;
grant select, insert, update on table private.dashboard_sector_order_codes to service_role;
grant select, insert, update on table private.dashboard_order_code_counters to service_role;
grant select, insert, update on table private.dashboard_order_code_reservations to service_role;

create or replace function private.dashboard_reserve_order_code(
  p_event_id text,
  p_sector_id uuid
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event_id text := pg_catalog.btrim(p_event_id);
  v_existing private.dashboard_order_code_reservations%rowtype;
  v_sector_code smallint;
  v_order_year integer;
  v_order_number bigint;
  v_order_ref text;
begin
  if p_event_id is null
     or v_event_id = ''
     or v_event_id <> p_event_id
     or pg_catalog.length(v_event_id) > 180 then
    raise exception using errcode = '22023', message = 'Identificador do evento inválido para gerar o código da encomenda.';
  end if;

  if p_sector_id is null then
    raise exception using errcode = '22023', message = 'O setor do pedido é obrigatório para gerar o código da encomenda.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_event_id, 0));

  select reservation.*
    into v_existing
  from private.dashboard_order_code_reservations as reservation
  where reservation.event_id = v_event_id;

  if found then
    if v_existing.sector_id <> p_sector_id then
      raise exception using errcode = '22023', message = 'Este evento já está reservado para outro setor.';
    end if;
    return v_existing.order_ref;
  end if;

  select mapping.sector_code
    into v_sector_code
  from private.dashboard_sector_order_codes as mapping
  join public.sectors as s on s.id = mapping.sector_id
  where mapping.sector_id = p_sector_id
    and s.active is true;

  if v_sector_code is null then
    raise exception using errcode = 'P0002', message = 'Setor ativo sem código numérico de encomenda.';
  end if;

  v_order_year := extract(year from (pg_catalog.clock_timestamp() at time zone 'America/Sao_Paulo'))::integer;

  insert into private.dashboard_order_code_counters as counter (
    order_year, sector_code, last_number
  )
  values (v_order_year, v_sector_code, 1)
  on conflict (order_year, sector_code) do update
    set last_number = counter.last_number + 1
  returning last_number into v_order_number;

  v_order_ref := 'ENC ' || v_order_year::text || '.'
    || pg_catalog.lpad(v_sector_code::text, 3, '0') || '.'
    || pg_catalog.lpad(v_order_number::text, 3, '0');

  insert into private.dashboard_order_code_reservations (
    event_id, sector_id, order_year, sector_code, order_number, order_ref
  ) values (
    v_event_id, p_sector_id, v_order_year, v_sector_code, v_order_number, v_order_ref
  );

  return v_order_ref;
end;
$$;

revoke all on function private.dashboard_reserve_order_code(text, uuid) from public, anon, authenticated;
grant execute on function private.dashboard_reserve_order_code(text, uuid) to service_role;

do $$
begin
  if pg_catalog.to_regprocedure('public.dashboard_process_event(text,text,text,jsonb)') is null then
    raise exception 'A função public.dashboard_process_event(text,text,text,jsonb) é necessária para instalar a geração de códigos.';
  end if;
end;
$$;

create or replace function public.dashboard_create_order_with_code(
  p_event_id text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sector_id uuid;
  v_order_ref text;
  v_payload jsonb;
  v_result jsonb;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object'
     or pg_catalog.jsonb_typeof(p_payload->'items') <> 'array' then
    raise exception using errcode = '22023', message = 'O conteúdo dos itens do pedido é inválido.';
  end if;

  select (item.value->>'sector_id')::uuid
    into v_sector_id
  from pg_catalog.jsonb_array_elements(p_payload->'items') with ordinality as item(value, position)
  order by item.position
  limit 1;

  if v_sector_id is null then
    raise exception using errcode = '22023', message = 'O pedido precisa ter ao menos um setor válido.';
  end if;

  v_order_ref := private.dashboard_reserve_order_code(p_event_id, v_sector_id);
  v_payload := pg_catalog.jsonb_set(
    p_payload,
    '{order}',
    coalesce(p_payload->'order', '{}'::jsonb) || pg_catalog.jsonb_build_object('id', v_order_ref),
    true
  );

  v_result := public.dashboard_process_event(p_event_id, 'order.created', v_order_ref, v_payload);

  return pg_catalog.jsonb_build_object('ok', true, 'order_ref', v_order_ref, 'result', v_result);
end;
$$;

revoke all on function public.dashboard_create_order_with_code(text, jsonb) from public, anon, authenticated;
grant execute on function public.dashboard_create_order_with_code(text, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
