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
  v_match_count integer;
  v_assignment_pattern text := $pattern$v_size_label[[:space:]]*:=[[:space:]]*nullif[[:space:]]*[(][[:space:]]*trim[[:space:]]*[(][[:space:]]*coalesce[[:space:]]*[(][[:space:]]*v_item->>'size_label'[[:space:]]*,[[:space:]]*v_item->>'size'[[:space:]]*[)][[:space:]]*[)][[:space:]]*,[[:space:]]*''[[:space:]]*[)][[:space:]]*;$pattern$;
  v_new_assignment text := $new$v_size_label := nullif(trim(coalesce(
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
  v_columns_pattern text := $pattern$size_label,[[:space:]]+sector_id,$pattern$;
  v_new_columns text := $new$size_label,
          product_size_id,
          sector_id,$new$;
  v_values_pattern text := $pattern$v_size_label,[[:space:]]+v_sector_id,$pattern$;
  v_new_values text := $new$v_size_label,
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

  select count(*) into v_match_count
  from regexp_matches(v_definition, v_assignment_pattern, 'g');
  if v_match_count <> 1 then
    raise exception 'Esperada uma leitura de tamanho na RPC de pedidos; encontradas %.', v_match_count;
  end if;
  v_updated := regexp_replace(v_definition, v_assignment_pattern, v_new_assignment, 'g');
  if v_updated = v_definition then
    raise exception 'A substituição da leitura de tamanho não alterou a RPC de pedidos.';
  end if;
  v_definition := v_updated;

  select count(*) into v_match_count
  from regexp_matches(v_definition, v_columns_pattern, 'g');
  if v_match_count <> 1 then
    raise exception 'Esperada uma lista de colunas dos itens na RPC de pedidos; encontradas %.', v_match_count;
  end if;
  v_updated := regexp_replace(v_definition, v_columns_pattern, v_new_columns, 'g');
  if v_updated = v_definition then
    raise exception 'A substituição das colunas dos itens não alterou a RPC de pedidos.';
  end if;
  v_definition := v_updated;

  select count(*) into v_match_count
  from regexp_matches(v_definition, v_values_pattern, 'g');
  if v_match_count <> 1 then
    raise exception 'Esperada uma lista de valores dos itens na RPC de pedidos; encontradas %.', v_match_count;
  end if;
  v_updated := regexp_replace(v_definition, v_values_pattern, v_new_values, 'g');
  if v_updated = v_definition then
    raise exception 'A substituição dos valores dos itens não alterou a RPC de pedidos.';
  end if;

  execute v_updated;
end;
$$;

notify pgrst, 'reload schema';

commit;
