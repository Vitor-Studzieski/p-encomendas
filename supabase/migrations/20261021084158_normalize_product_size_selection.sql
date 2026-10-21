-- Store selected product sizes by catalog ID. Keep size_label as a human-readable
-- snapshot so existing dashboard views and order history remain compatible.
begin;

alter table public.order_items
  add column if not exists product_size_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.product_sizes'::regclass
      and conname = 'product_sizes_product_id_id_key'
  ) then
    alter table public.product_sizes
      add constraint product_sizes_product_id_id_key unique (product_id, id);
  end if;
end;
$$;

-- Link historical rows only when the old text label identifies exactly one size.
with size_matches as (
  select
    oi.id as order_item_id,
    (array_agg(ps.id))[1] as product_size_id,
    count(*) as match_count
  from public.order_items as oi
  join public.product_sizes as ps
    on ps.product_id = oi.product_id
   and ps.label = oi.size_label
  where oi.product_size_id is null
    and oi.size_label is not null
  group by oi.id
)
update public.order_items as oi
set product_size_id = matches.product_size_id
from size_matches as matches
where matches.order_item_id = oi.id
  and matches.match_count = 1;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_product_size_fkey'
  ) then
    alter table public.order_items
      add constraint order_items_product_size_fkey
      foreign key (product_id, product_size_id)
      references public.product_sizes (product_id, id)
      on update cascade
      on delete restrict
      not valid;
  end if;
end;
$$;

alter table public.order_items
  validate constraint order_items_product_size_fkey;

create or replace function public.validate_order_item_size()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_active_size_count integer;
  v_label_match_count integer;
  v_resolved_size_id uuid;
  v_resolved_label text;
begin
  if new.product_size_id is not null then
    select ps.id, ps.label
      into v_resolved_size_id, v_resolved_label
    from public.product_sizes as ps
    where ps.id = new.product_size_id
      and ps.product_id = new.product_id
      and ps.active is true
    limit 1;

    if v_resolved_size_id is null then
      raise exception using
        errcode = '22023',
        message = 'O tamanho selecionado não está mais disponível para este produto.';
    end if;
  elsif new.size_label is not null then
    select count(*)
      into v_label_match_count
    from public.product_sizes as ps
    where ps.product_id = new.product_id
      and ps.label = new.size_label
      and ps.active is true;

    if v_label_match_count <> 1 then
      raise exception using
        errcode = '22023',
        message = 'O tamanho informado não identifica uma opção única e ativa para este produto.';
    end if;

    select ps.id, ps.label
      into v_resolved_size_id, v_resolved_label
    from public.product_sizes as ps
    where ps.product_id = new.product_id
      and ps.label = new.size_label
      and ps.active is true
    limit 1;
  else
    select count(*)
      into v_active_size_count
    from public.product_sizes as ps
    where ps.product_id = new.product_id
      and ps.active is true;

    if v_active_size_count > 1 then
      raise exception using
        errcode = '22023',
        message = 'Escolha um dos tamanhos disponíveis para este produto.';
    elsif v_active_size_count = 1 then
      select ps.id, ps.label
        into v_resolved_size_id, v_resolved_label
      from public.product_sizes as ps
      where ps.product_id = new.product_id
        and ps.active is true
      limit 1;
    end if;
  end if;

  if v_resolved_size_id is not null then
    new.product_size_id := v_resolved_size_id;
    new.size_label := v_resolved_label;
  elsif new.size_label is not null then
    raise exception using
      errcode = '22023',
      message = 'Este produto não possui o tamanho informado no catálogo.';
  end if;

  return new;
end;
$$;

-- Pass the selected size ID through the existing RPC while preserving its public
-- signature and all current order/event behavior.
do $$
declare
  v_definition text;
  v_updated text;
  v_old_assignment text := $old$        v_size_label := nullif(trim(coalesce(
          v_item->>'size_label',
          v_item->>'size'
        )), '');$old$;
  v_new_assignment text := $new$        v_size_label := nullif(trim(coalesce(
          v_item->>'size_label',
          v_item->>'size'
        )), '');
        v_size_ref := nullif(trim(coalesce(
          v_item->>'product_size_id',
          v_item->>'size_id'
        )), '');
        if v_size_ref is not null and v_size_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception using errcode = '22023', message = 'O tamanho selecionado é inválido.';
        end if;
        v_product_size_id := case when v_size_ref is null then null else v_size_ref::uuid end;$new$;
  v_old_columns text := $old$          size_label,
          sector_id,$old$;
  v_new_columns text := $new$          size_label,
          product_size_id,
          sector_id,$new$;
  v_old_values text := $old$          v_size_label,
          v_sector_id,$old$;
  v_new_values text := $new$          v_size_label,
          v_product_size_id,
          v_sector_id,$new$;
begin
  select pg_catalog.pg_get_functiondef(p.oid)
    into v_definition
  from pg_catalog.pg_proc as p
  where p.oid = 'public.dashboard_process_event(text,text,text,jsonb)'::regprocedure;

  if v_definition is null then
    raise exception 'A função public.dashboard_process_event(text,text,text,jsonb) não foi encontrada.';
  end if;

  v_definition := replace(v_definition, E'\r\n', E'\n');
  v_updated := replace(v_definition, '  v_size_label text;', E'  v_size_label text;\n  v_size_ref text;\n  v_product_size_id uuid;');
  if v_updated = v_definition then
    raise exception 'Não foi possível localizar a declaração de v_size_label na RPC de pedidos.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_old_assignment, v_new_assignment);
  if v_updated = v_definition then
    raise exception 'Não foi possível localizar a leitura de tamanho na RPC de pedidos.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_old_columns, v_new_columns);
  if v_updated = v_definition then
    raise exception 'Não foi possível localizar as colunas dos itens na RPC de pedidos.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition, v_old_values, v_new_values);
  if v_updated = v_definition then
    raise exception 'Não foi possível localizar os valores dos itens na RPC de pedidos.';
  end if;

  execute v_updated;
end;
$$;

notify pgrst, 'reload schema';

commit;
