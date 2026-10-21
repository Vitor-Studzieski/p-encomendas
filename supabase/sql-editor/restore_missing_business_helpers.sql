-- Restore helper functions required by public.dashboard_process_event.
-- Run in the Supabase SQL Editor. This does not create or send an order.

begin;

grant usage on schema private to service_role;

create or replace function private.dashboard_parse_date(p_value text)
returns date
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_value text := nullif(pg_catalog.btrim(p_value), '');
begin
  if v_value is null or v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;

  return v_value::date;
exception
  when others then
    return null;
end;
$$;

create or replace function private.dashboard_parse_time(p_value text)
returns time
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_value text := nullif(pg_catalog.btrim(p_value), '');
begin
  if v_value is null
     or v_value !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9]([.][0-9]{1,6})?)?$' then
    return null;
  end if;

  return v_value::time;
exception
  when others then
    return null;
end;
$$;

create or replace function private.dashboard_resolve_order(p_order_ref text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_order_ref text := nullif(pg_catalog.btrim(p_order_ref), '');
  v_order_id uuid;
begin
  if v_order_ref is null then
    raise exception using errcode = '22023', message = 'order_ref é obrigatório';
  end if;

  select o.id
    into v_order_id
  from public.orders as o
  where o.external_order_id = v_order_ref
  limit 1;

  if v_order_id is null
     and v_order_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select o.id
      into v_order_id
    from public.orders as o
    where o.id = v_order_ref::uuid
    limit 1;
  end if;

  if v_order_id is null then
    raise exception using
      errcode = 'P0002',
      message = pg_catalog.format('Pedido não encontrado: %s', v_order_ref);
  end if;

  return v_order_id;
end;
$$;

create or replace function private.dashboard_resolve_product(p_item jsonb)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_product_ref text;
  v_product_name text;
  v_product_id uuid;
  v_match_count bigint;
begin
  if p_item is null or pg_catalog.jsonb_typeof(p_item) <> 'object' then
    raise exception using errcode = '22023', message = 'Item do pedido inválido';
  end if;

  v_product_ref := coalesce(
    nullif(pg_catalog.btrim(p_item->>'product_id'), ''),
    nullif(pg_catalog.btrim(p_item->>'id'), '')
  );
  v_product_name := coalesce(
    nullif(pg_catalog.btrim(p_item->>'name'), ''),
    nullif(pg_catalog.btrim(p_item->>'product_name'), '')
  );

  if v_product_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select p.id
      into v_product_id
    from public.products as p
    where p.id = v_product_ref::uuid
      and p.active is true
    limit 1;
  end if;

  if v_product_id is null and v_product_name is not null then
    select pg_catalog.count(*)
      into v_match_count
    from public.products as p
    where p.active is true
      and pg_catalog.lower(pg_catalog.btrim(p.name)) = pg_catalog.lower(v_product_name);

    if v_match_count > 1 then
      raise exception using
        errcode = '21000',
        message = pg_catalog.format('Nome de produto ambíguo no catálogo: %s', v_product_name);
    elsif v_match_count = 1 then
      select p.id
        into v_product_id
      from public.products as p
      where p.active is true
        and pg_catalog.lower(pg_catalog.btrim(p.name)) = pg_catalog.lower(v_product_name)
      limit 1;
    end if;
  end if;

  if v_product_id is null then
    raise exception using
      errcode = 'P0002',
      message = pg_catalog.format('Produto ativo não encontrado: %s', coalesce(v_product_name, v_product_ref, '(sem nome)'));
  end if;

  return v_product_id;
end;
$$;

create or replace function private.dashboard_resolve_sector(
  p_sector_value jsonb,
  p_product_id uuid default null
)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_sector_text text;
  v_sector_id uuid;
  v_match_count bigint;
begin
  -- The order payload supplies the selected sector explicitly. Keep the product
  -- argument for the signature used by dashboard_process_event.
  perform p_product_id;

  if pg_catalog.jsonb_typeof(p_sector_value) = 'string' then
    v_sector_text := nullif(pg_catalog.btrim(p_sector_value #>> '{}'), '');
  elsif pg_catalog.jsonb_typeof(p_sector_value) = 'object' then
    v_sector_text := coalesce(
      nullif(pg_catalog.btrim(p_sector_value->>'id'), ''),
      nullif(pg_catalog.btrim(p_sector_value->>'sector_id'), ''),
      nullif(pg_catalog.btrim(p_sector_value->>'slug'), ''),
      nullif(pg_catalog.btrim(p_sector_value->>'name'), '')
    );
  end if;

  if v_sector_text is null then
    raise exception using errcode = '22023', message = 'Setor do pedido não informado';
  end if;

  if v_sector_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select s.id
      into v_sector_id
    from public.sectors as s
    where s.id = v_sector_text::uuid
    limit 1;
  end if;

  if v_sector_id is null then
    select pg_catalog.count(*)
      into v_match_count
    from public.sectors as s
    where pg_catalog.lower(pg_catalog.btrim(s.name)) = pg_catalog.lower(v_sector_text)
       or pg_catalog.lower(pg_catalog.btrim(coalesce(s.slug, ''))) = pg_catalog.lower(v_sector_text);

    if v_match_count > 1 then
      raise exception using
        errcode = '21000',
        message = pg_catalog.format('Nome de setor ambíguo: %s', v_sector_text);
    elsif v_match_count = 1 then
      select s.id
        into v_sector_id
      from public.sectors as s
      where pg_catalog.lower(pg_catalog.btrim(s.name)) = pg_catalog.lower(v_sector_text)
         or pg_catalog.lower(pg_catalog.btrim(coalesce(s.slug, ''))) = pg_catalog.lower(v_sector_text)
      limit 1;
    end if;
  end if;

  if v_sector_id is null then
    raise exception using
      errcode = 'P0002',
      message = pg_catalog.format('Setor não encontrado: %s', v_sector_text);
  end if;

  return v_sector_id;
end;
$$;

revoke all on function private.dashboard_parse_date(text) from public, anon, authenticated;
revoke all on function private.dashboard_parse_time(text) from public, anon, authenticated;
revoke all on function private.dashboard_resolve_order(text) from public, anon, authenticated;
revoke all on function private.dashboard_resolve_product(jsonb) from public, anon, authenticated;
revoke all on function private.dashboard_resolve_sector(jsonb, uuid) from public, anon, authenticated;

grant execute on function private.dashboard_parse_date(text) to service_role;
grant execute on function private.dashboard_parse_time(text) to service_role;
grant execute on function private.dashboard_resolve_order(text) to service_role;
grant execute on function private.dashboard_resolve_product(jsonb) to service_role;
grant execute on function private.dashboard_resolve_sector(jsonb, uuid) to service_role;

-- Run lightweight checks without inserting or changing order data.
do $$
declare
  v_sector_id uuid;
  v_sector_name text;
  v_product_id uuid;
  v_product_name text;
  v_order_id uuid;
  v_order_ref text;
begin
  if private.dashboard_parse_date('2026-10-20') is distinct from date '2026-10-20'
     or private.dashboard_parse_date('2026-02-30') is not null then
    raise exception 'Validação de dashboard_parse_date falhou';
  end if;

  if private.dashboard_parse_time('08:51') is distinct from time '08:51'
     or private.dashboard_parse_time('25:00') is not null then
    raise exception 'Validação de dashboard_parse_time falhou';
  end if;

  select s.id, s.name
    into v_sector_id, v_sector_name
  from public.sectors as s
  order by s.name
  limit 1;

  if v_sector_id is null
     or private.dashboard_resolve_sector(pg_catalog.to_jsonb(v_sector_name)) is distinct from v_sector_id
     or private.dashboard_resolve_sector(pg_catalog.to_jsonb(v_sector_id::text), null::uuid) is distinct from v_sector_id then
    raise exception 'Validação de dashboard_resolve_sector falhou';
  end if;

  select p.id, p.name
    into v_product_id, v_product_name
  from public.products as p
  where p.active is true
  order by p.name
  limit 1;

  if v_product_id is not null
     and private.dashboard_resolve_product(pg_catalog.jsonb_build_object('name', v_product_name)) is distinct from v_product_id then
    raise exception 'Validação de dashboard_resolve_product falhou';
  end if;

  select o.id, coalesce(o.external_order_id, o.id::text)
    into v_order_id, v_order_ref
  from public.orders as o
  limit 1;

  if v_order_id is not null
     and private.dashboard_resolve_order(v_order_ref) is distinct from v_order_id then
    raise exception 'Validação de dashboard_resolve_order falhou';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
