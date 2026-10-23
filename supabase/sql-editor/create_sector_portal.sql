-- Portal de setores independente da dashboard e do WhatsApp.
-- Cria tabelas e RPCs próprias: não lê nem grava pedidos, agenda, eventos ou outbox existentes.
-- Execute no SQL Editor do Supabase usado pelo portal.

begin;

create sequence if not exists public.sector_portal_order_code_seq;

create table if not exists public.sector_portal_sectors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sector_portal_accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null unique check (email = lower(btrim(email)) and length(email) between 3 and 254),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role text not null check (role in ('manager', 'sector', 'fiscal')),
  sector_id uuid references public.sector_portal_sectors(id) on delete restrict,
  active boolean not null default true,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sector_portal_accounts_role_sector_check check (
    (role = 'sector' and sector_id is not null) or (role in ('manager', 'fiscal') and sector_id is null)
  )
);

create unique index if not exists sector_portal_accounts_single_active_manager_idx
  on public.sector_portal_accounts (role) where role = 'manager' and active = true;

create table if not exists public.sector_portal_orders (
  id uuid primary key default gen_random_uuid(),
  display_id text not null unique,
  customer_name text not null check (length(btrim(customer_name)) between 1 and 120),
  customer_phone text not null default '' check (length(customer_phone) <= 40),
  requested_date date not null,
  requested_time time not null,
  pickup_location text not null default '' check (length(pickup_location) <= 240),
  confirmation_sector_id uuid not null references public.sector_portal_sectors(id) on delete restrict,
  status text not null default 'awaiting_confirmation'
    check (status in ('awaiting_confirmation', 'confirmed', 'preparing', 'ready', 'cancelled')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sector_portal_order_sectors (
  order_id uuid not null references public.sector_portal_orders(id) on delete cascade,
  sector_id uuid not null references public.sector_portal_sectors(id) on delete restrict,
  stage text not null check (stage in ('awaiting_confirmation', 'blocked', 'planned', 'in_progress', 'completed', 'needs_attention', 'cancelled')),
  previous_stage text check (previous_stage is null or previous_stage in ('awaiting_confirmation', 'blocked', 'planned', 'in_progress')),
  updated_at timestamptz not null default now(),
  primary key (order_id, sector_id)
);

create table if not exists public.sector_portal_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  sector_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 160),
  quantity numeric(12, 3) not null check (quantity > 0 and quantity <= 100000),
  size_label text not null default '' check (length(size_label) <= 120),
  created_at timestamptz not null default now(),
  foreign key (order_id, sector_id) references public.sector_portal_order_sectors(order_id, sector_id) on delete cascade
);

create table if not exists public.sector_portal_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.sector_portal_orders(id) on delete cascade,
  sector_id uuid not null references public.sector_portal_sectors(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'returned_to_sector', 'impossible')),
  fiscal_resolution text not null default '' check (length(fiscal_resolution) <= 1000),
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.sector_portal_action_events (
  event_id text primary key check (length(event_id) between 1 and 180),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null,
  entity_id uuid,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sector_portal_rate_limits (
  scope text not null check (scope like 'sector-portal-%'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  hit_count integer not null check (hit_count > 0),
  window_expires_at timestamptz not null,
  primary key (scope, fingerprint)
);

create unique index if not exists sector_portal_reviews_one_pending_idx
  on public.sector_portal_reviews (order_id, sector_id) where status = 'pending';
create index if not exists sector_portal_orders_queue_idx
  on public.sector_portal_orders (status, requested_date, requested_time);
create index if not exists sector_portal_orders_confirmation_sector_idx
  on public.sector_portal_orders (confirmation_sector_id);
create index if not exists sector_portal_orders_creator_idx
  on public.sector_portal_orders (created_by);
create index if not exists sector_portal_accounts_sector_idx
  on public.sector_portal_accounts (sector_id) where sector_id is not null;
create index if not exists sector_portal_order_sectors_queue_idx
  on public.sector_portal_order_sectors (sector_id, stage, updated_at);
create index if not exists sector_portal_reviews_queue_idx
  on public.sector_portal_reviews (status, created_at);
create index if not exists sector_portal_reviews_order_sector_idx
  on public.sector_portal_reviews (order_id, sector_id);
create index if not exists sector_portal_reviews_sector_idx
  on public.sector_portal_reviews (sector_id);
create index if not exists sector_portal_reviews_requested_by_idx
  on public.sector_portal_reviews (requested_by);
create index if not exists sector_portal_reviews_resolved_by_idx
  on public.sector_portal_reviews (resolved_by) where resolved_by is not null;
create index if not exists sector_portal_action_events_actor_idx
  on public.sector_portal_action_events (actor_user_id, created_at);
create index if not exists sector_portal_items_order_idx
  on public.sector_portal_order_items (order_id, sector_id);
create index if not exists sector_portal_items_sector_idx
  on public.sector_portal_order_items (sector_id);
create index if not exists sector_portal_rate_limits_expiry_idx
  on public.sector_portal_rate_limits (window_expires_at);

insert into public.sector_portal_sectors (name, slug)
values
  ('Padaria', 'padaria'),
  ('Confeitaria', 'confeitaria'),
  ('Açougue', 'acougue'),
  ('Frios', 'frios'),
  ('Rotisseria', 'rotisseria')
on conflict (slug) do nothing;

alter table public.sector_portal_sectors enable row level security;
alter table public.sector_portal_accounts enable row level security;
alter table public.sector_portal_orders enable row level security;
alter table public.sector_portal_order_sectors enable row level security;
alter table public.sector_portal_order_items enable row level security;
alter table public.sector_portal_reviews enable row level security;
alter table public.sector_portal_action_events enable row level security;
alter table public.sector_portal_rate_limits enable row level security;

revoke all on table public.sector_portal_sectors, public.sector_portal_accounts,
  public.sector_portal_orders, public.sector_portal_order_sectors,
  public.sector_portal_order_items, public.sector_portal_reviews,
  public.sector_portal_action_events, public.sector_portal_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.sector_portal_sectors,
  public.sector_portal_accounts, public.sector_portal_orders,
  public.sector_portal_order_sectors, public.sector_portal_order_items,
  public.sector_portal_reviews, public.sector_portal_action_events,
  public.sector_portal_rate_limits to service_role;
grant usage, select on sequence public.sector_portal_order_code_seq to service_role;

create or replace function public.sector_portal_consume_rate_limit(
  p_fingerprint text,
  p_scope text,
  p_max_hits integer,
  p_window_seconds integer
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_hit_count integer;
  v_expires_at timestamptz;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
     or p_scope is null or p_scope not like 'sector-portal-%'
     or p_max_hits is null or p_max_hits < 1 or p_max_hits > 1000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception using errcode = '22023', message = 'Parâmetros de limite inválidos.';
  end if;

  if pg_catalog.random() < 0.01 then
    delete from public.sector_portal_rate_limits where window_expires_at < pg_catalog.now() - pg_catalog.make_interval(days => 1);
  end if;

  insert into public.sector_portal_rate_limits as limits (scope, fingerprint, hit_count, window_expires_at)
  values (p_scope, p_fingerprint, 1, pg_catalog.now() + pg_catalog.make_interval(secs => p_window_seconds))
  on conflict (scope, fingerprint) do update
    set hit_count = case when limits.window_expires_at <= pg_catalog.now() then 1 else least(limits.hit_count + 1, p_max_hits + 1) end,
        window_expires_at = case when limits.window_expires_at <= pg_catalog.now() then pg_catalog.now() + pg_catalog.make_interval(secs => p_window_seconds) else limits.window_expires_at end
  returning hit_count, window_expires_at into v_hit_count, v_expires_at;

  allowed := v_hit_count <= p_max_hits;
  retry_after_seconds := greatest(1, pg_catalog.ceil(pg_catalog.date_part('epoch', v_expires_at - pg_catalog.now()))::integer);
  return next;
end;
$$;

create or replace function public.sector_portal_create_order(
  p_event_id text,
  p_actor_user_id uuid,
  p_order jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_saved public.sector_portal_action_events%rowtype;
  v_order public.sector_portal_orders%rowtype;
  v_item jsonb;
  v_sector_id uuid;
  v_first_sector uuid;
  v_number bigint;
  v_year text := pg_catalog.to_char(current_date, 'YYYY');
  v_result jsonb;
begin
  if p_event_id is null or pg_catalog.length(pg_catalog.btrim(p_event_id)) not between 1 and 180
     or p_actor_user_id is null or p_order is null or pg_catalog.jsonb_typeof(p_order) <> 'object' then
    raise exception using errcode = '22023', message = 'Dados da encomenda inválidos.';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = '22023', message = 'A encomenda precisa ter uma lista de itens.';
  end if;
  if pg_catalog.jsonb_array_length(p_items) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Adicione de 1 a 100 itens à encomenda.';
  end if;
  if not exists (select 1 from public.sector_portal_accounts a where a.auth_user_id = p_actor_user_id and a.role = 'manager' and a.active = true and a.must_change_password = false) then
    raise exception using errcode = '42501', message = 'A conta não pode cadastrar encomendas.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_event_id, 0));
  select e.* into v_saved from public.sector_portal_action_events e where e.event_id = p_event_id;
  if found then
    if v_saved.actor_user_id <> p_actor_user_id or v_saved.event_type <> 'order.created' then
      raise exception using errcode = '42501', message = 'Este identificador já foi usado em outra ação.';
    end if;
    return v_saved.result;
  end if;

  if pg_catalog.length(pg_catalog.btrim(coalesce(p_order->>'customer_name', ''))) not between 1 and 120
     or pg_catalog.length(coalesce(p_order->>'customer_phone', '')) > 40
     or pg_catalog.length(coalesce(p_order->>'pickup_location', '')) > 240 then
    raise exception using errcode = '22023', message = 'Dados do cliente inválidos.';
  end if;
  v_first_sector := nullif(p_items->0->>'sector_id', '')::uuid;
  if v_first_sector is null or not exists (select 1 from public.sector_portal_sectors s where s.id = v_first_sector and s.active = true) then
    raise exception using errcode = '22023', message = 'O primeiro item precisa pertencer a um setor ativo.';
  end if;

  v_number := pg_catalog.nextval('public.sector_portal_order_code_seq'::regclass);
  insert into public.sector_portal_orders (
    display_id, customer_name, customer_phone, requested_date, requested_time,
    pickup_location, confirmation_sector_id, status, created_by
  ) values (
    'SP-' || v_year || '-' || pg_catalog.lpad(v_number::text, 6, '0'),
    pg_catalog.btrim(p_order->>'customer_name'),
    pg_catalog.btrim(coalesce(p_order->>'customer_phone', '')),
    (p_order->>'requested_date')::date,
    (p_order->>'requested_time')::time,
    pg_catalog.btrim(coalesce(p_order->>'pickup_location', '')),
    v_first_sector,
    'awaiting_confirmation', p_actor_user_id
  ) returning * into v_order;

  for v_item in select value from pg_catalog.jsonb_array_elements(p_items) loop
    v_sector_id := nullif(v_item->>'sector_id', '')::uuid;
    if v_sector_id is null or pg_catalog.length(pg_catalog.btrim(coalesce(v_item->>'name', ''))) not between 1 and 160
       or coalesce((v_item->>'quantity')::numeric, 0) <= 0
       or coalesce((v_item->>'quantity')::numeric, 0) > 100000
       or pg_catalog.length(coalesce(v_item->>'size_label', '')) > 120
       or not exists (select 1 from public.sector_portal_sectors s where s.id = v_sector_id and s.active = true) then
      raise exception using errcode = '22023', message = 'Um dos itens tem dados inválidos ou setor inativo.';
    end if;
    insert into public.sector_portal_order_sectors (order_id, sector_id, stage)
    values (v_order.id, v_sector_id, 'blocked')
    on conflict (order_id, sector_id) do nothing;
    insert into public.sector_portal_order_items (order_id, sector_id, name, quantity, size_label)
    values (v_order.id, v_sector_id, pg_catalog.btrim(v_item->>'name'), (v_item->>'quantity')::numeric, pg_catalog.btrim(coalesce(v_item->>'size_label', '')));
  end loop;

  update public.sector_portal_orders set confirmation_sector_id = v_first_sector where id = v_order.id returning * into v_order;
  update public.sector_portal_order_sectors set stage = case when sector_id = v_first_sector then 'awaiting_confirmation' else 'blocked' end
  where order_id = v_order.id;

  v_result := pg_catalog.jsonb_build_object('ok', true, 'order', pg_catalog.to_jsonb(v_order));
  insert into public.sector_portal_action_events (event_id, actor_user_id, event_type, entity_id, result)
  values (p_event_id, p_actor_user_id, 'order.created', v_order.id, v_result);
  return v_result;
end;
$$;

create or replace function public.sector_portal_apply_action(
  p_event_id text,
  p_action text,
  p_actor_user_id uuid,
  p_order_id uuid,
  p_sector_id uuid,
  p_review_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_saved public.sector_portal_action_events%rowtype;
  v_order public.sector_portal_orders%rowtype;
  v_assignment public.sector_portal_order_sectors%rowtype;
  v_review public.sector_portal_reviews%rowtype;
  v_result jsonb;
  v_entity uuid;
begin
  if p_event_id is null or pg_catalog.length(pg_catalog.btrim(p_event_id)) not between 1 and 180 or p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'Identificação da ação inválida.';
  end if;
  if p_action is null or p_action not in ('confirm', 'start_preparing', 'mark_ready', 'request_review', 'fiscal_possible', 'fiscal_impossible') then
    raise exception using errcode = '22023', message = 'Ação do portal inválida.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_event_id, 0));
  select e.* into v_saved from public.sector_portal_action_events e where e.event_id = p_event_id;
  if found then
    if v_saved.actor_user_id <> p_actor_user_id or v_saved.event_type <> p_action
       or (p_order_id is not null and v_saved.entity_id <> p_order_id)
       or (p_review_id is not null and v_saved.entity_id <> p_review_id) then
      raise exception using errcode = '42501', message = 'Este identificador já foi usado em outra ação.';
    end if;
    return v_saved.result;
  end if;

  if p_action in ('fiscal_possible', 'fiscal_impossible') then
    if not exists (select 1 from public.sector_portal_accounts a where a.auth_user_id = p_actor_user_id and a.role = 'fiscal' and a.active = true and a.must_change_password = false) then
      raise exception using errcode = '42501', message = 'A conta não pode resolver análises.';
    end if;
    if p_review_id is null or pg_catalog.length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 1 and 1000 then
      raise exception using errcode = '22023', message = 'Registre a decisão da análise.';
    end if;
    select r.* into v_review from public.sector_portal_reviews r where r.id = p_review_id and r.status = 'pending' for update;
    if not found then raise exception using errcode = 'P0002', message = 'A análise não está mais pendente.'; end if;
    select o.* into v_order from public.sector_portal_orders o where o.id = v_review.order_id for update;
    if not found or v_order.status in ('ready', 'cancelled') then
      raise exception using errcode = 'P0001', message = 'O pedido já foi encerrado.';
    end if;
    if p_action = 'fiscal_possible' then
      update public.sector_portal_reviews set status = 'returned_to_sector', fiscal_resolution = pg_catalog.btrim(p_reason), resolved_by = p_actor_user_id, resolved_at = pg_catalog.now() where id = p_review_id returning * into v_review;
      update public.sector_portal_order_sectors set stage = coalesce(nullif(previous_stage, 'needs_attention'), 'planned'), previous_stage = null, updated_at = pg_catalog.now()
      where order_id = v_review.order_id and sector_id = v_review.sector_id and stage = 'needs_attention';
    else
      update public.sector_portal_reviews set status = 'impossible', fiscal_resolution = pg_catalog.btrim(p_reason), resolved_by = p_actor_user_id, resolved_at = pg_catalog.now() where id = p_review_id returning * into v_review;
      update public.sector_portal_reviews set status = 'impossible', fiscal_resolution = coalesce(nullif(fiscal_resolution, ''), 'Encomenda encerrada após análise da Fiscal.'), resolved_by = p_actor_user_id, resolved_at = pg_catalog.now()
      where order_id = v_order.id and status = 'pending';
      update public.sector_portal_orders set status = 'cancelled', updated_at = pg_catalog.now() where id = v_order.id returning * into v_order;
      update public.sector_portal_order_sectors set stage = 'cancelled', updated_at = pg_catalog.now() where order_id = v_order.id;
    end if;
    v_entity := p_review_id;
    v_result := pg_catalog.jsonb_build_object('ok', true, 'action', p_action, 'review', pg_catalog.to_jsonb(v_review), 'order_status', v_order.status);
  else
    if p_action not in ('confirm', 'start_preparing', 'mark_ready', 'request_review') or p_order_id is null or p_sector_id is null then
      raise exception using errcode = '22023', message = 'Ação do setor inválida.';
    end if;
    if not exists (select 1 from public.sector_portal_accounts a where a.auth_user_id = p_actor_user_id and a.role = 'sector' and a.sector_id = p_sector_id and a.active = true and a.must_change_password = false) then
      raise exception using errcode = '42501', message = 'A conta não pode atualizar este setor.';
    end if;
    select o.* into v_order from public.sector_portal_orders o where o.id = p_order_id for update;
    if not found or v_order.status = 'cancelled' then raise exception using errcode = 'P0002', message = 'O pedido não foi encontrado ou foi cancelado.'; end if;
    select os.* into v_assignment from public.sector_portal_order_sectors os where os.order_id = p_order_id and os.sector_id = p_sector_id for update;
    if not found then raise exception using errcode = '42501', message = 'Este pedido não contém itens deste setor.'; end if;

    if p_action = 'confirm' then
      if v_order.confirmation_sector_id <> p_sector_id or v_order.status <> 'awaiting_confirmation' or v_assignment.stage <> 'awaiting_confirmation' then
        raise exception using errcode = 'P0001', message = 'Este setor não pode confirmar o pedido nesta etapa.';
      end if;
      if exists (select 1 from public.sector_portal_reviews r where r.order_id = p_order_id and r.status = 'pending') then
        raise exception using errcode = 'P0001', message = 'A Fiscal ainda está analisando este pedido.';
      end if;
      update public.sector_portal_orders set status = 'confirmed', updated_at = pg_catalog.now() where id = p_order_id;
      update public.sector_portal_order_sectors set stage = 'planned', updated_at = pg_catalog.now() where order_id = p_order_id and stage in ('awaiting_confirmation', 'blocked');
    elsif p_action = 'start_preparing' then
      if v_order.status not in ('confirmed', 'preparing') or v_assignment.stage <> 'planned' then
        raise exception using errcode = 'P0001', message = 'O pedido não está aguardando início da produção.';
      end if;
      if exists (select 1 from public.sector_portal_reviews r where r.order_id = p_order_id and r.sector_id = p_sector_id and r.status = 'pending') then
        raise exception using errcode = 'P0001', message = 'A produção está pausada até a Fiscal concluir a análise.';
      end if;
      update public.sector_portal_order_sectors set stage = 'in_progress', updated_at = pg_catalog.now() where order_id = p_order_id and sector_id = p_sector_id;
      update public.sector_portal_orders set status = 'preparing', updated_at = pg_catalog.now() where id = p_order_id;
    elsif p_action = 'mark_ready' then
      if v_order.status not in ('confirmed', 'preparing') or v_assignment.stage <> 'in_progress' then
        raise exception using errcode = 'P0001', message = 'Inicie a produção antes de marcar o pedido como pronto.';
      end if;
      if exists (select 1 from public.sector_portal_reviews r where r.order_id = p_order_id and r.sector_id = p_sector_id and r.status = 'pending') then
        raise exception using errcode = 'P0001', message = 'A produção está pausada até a Fiscal concluir a análise.';
      end if;
      update public.sector_portal_order_sectors set stage = 'completed', updated_at = pg_catalog.now() where order_id = p_order_id and sector_id = p_sector_id;
      if not exists (select 1 from public.sector_portal_order_sectors os where os.order_id = p_order_id and os.stage <> 'completed') then
        update public.sector_portal_orders set status = 'ready', updated_at = pg_catalog.now() where id = p_order_id;
      end if;
    elsif p_action = 'request_review' then
      if pg_catalog.length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 1 and 500 or v_assignment.stage in ('completed', 'cancelled', 'needs_attention') then
        raise exception using errcode = '22023', message = 'Informe um impedimento válido para a análise da Fiscal.';
      end if;
      if v_order.status in ('ready', 'cancelled') or exists (select 1 from public.sector_portal_reviews r where r.order_id = p_order_id and r.sector_id = p_sector_id and r.status = 'pending') then
        raise exception using errcode = 'P0001', message = 'O pedido não pode receber uma nova análise nesta etapa.';
      end if;
      insert into public.sector_portal_reviews (order_id, sector_id, requested_by, reason)
      values (p_order_id, p_sector_id, p_actor_user_id, pg_catalog.btrim(p_reason)) returning * into v_review;
      update public.sector_portal_order_sectors set previous_stage = stage, stage = 'needs_attention', updated_at = pg_catalog.now() where order_id = p_order_id and sector_id = p_sector_id;
    end if;
    v_entity := p_order_id;
    v_result := pg_catalog.jsonb_build_object('ok', true, 'action', p_action, 'order_id', p_order_id, 'status', (select o.status from public.sector_portal_orders o where o.id = p_order_id), 'review', case when v_review.id is null then null else pg_catalog.to_jsonb(v_review) end);
  end if;

  insert into public.sector_portal_action_events (event_id, actor_user_id, event_type, entity_id, result)
  values (p_event_id, p_actor_user_id, p_action, v_entity, v_result);
  return v_result;
end;
$$;

revoke all on function public.sector_portal_create_order(text, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.sector_portal_apply_action(text, text, uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.sector_portal_consume_rate_limit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.sector_portal_create_order(text, uuid, jsonb, jsonb) to service_role;
grant execute on function public.sector_portal_apply_action(text, text, uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.sector_portal_consume_rate_limit(text, text, integer, integer) to service_role;

notify pgrst, 'reload schema';
commit;
