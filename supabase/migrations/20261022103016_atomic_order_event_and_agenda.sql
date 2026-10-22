-- Durable WhatsApp notifications and atomic order/production-agenda transitions.
-- The existing business RPCs remain the source of order rules; this migration wraps
-- them in the same transaction and records outbound messages before commit.

begin;

create table if not exists public.dashboard_whatsapp_outbox (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  dedupe_key text not null unique,
  event_id text not null,
  event_type text not null,
  order_ref text,
  recipient_phone_e164 text not null check (recipient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  message text not null check (pg_catalog.length(message) between 1 and 10000),
  tag text not null,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'processing', 'sent', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamp with time zone not null default pg_catalog.now(),
  last_enqueued_at timestamp with time zone,
  locked_until timestamp with time zone,
  sent_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone not null default pg_catalog.now(),
  updated_at timestamp with time zone not null default pg_catalog.now()
);

create index if not exists dashboard_whatsapp_outbox_dispatch_idx
  on public.dashboard_whatsapp_outbox (status, available_at, created_at);

alter table public.dashboard_whatsapp_outbox enable row level security;
revoke all on table public.dashboard_whatsapp_outbox from public, anon, authenticated;
grant select, insert, update on table public.dashboard_whatsapp_outbox to service_role;

create or replace function public.dashboard_enqueue_whatsapp_outbox(
  p_event_id text,
  p_event_type text,
  p_order_ref text,
  p_notifications jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_notification jsonb;
  v_dedupe_key text;
  v_phone text;
  v_message text;
  v_tag text;
  v_ids jsonb := '[]'::jsonb;
  v_id uuid;
begin
  if p_event_id is null or pg_catalog.length(p_event_id) not between 1 and 180 then
    raise exception using errcode = '22023', message = 'Identificador do evento inválido para a fila de mensagens.';
  end if;
  if p_event_type is null or pg_catalog.length(p_event_type) not between 1 and 80 then
    raise exception using errcode = '22023', message = 'Tipo do evento inválido para a fila de mensagens.';
  end if;
  if p_notifications is null or pg_catalog.jsonb_typeof(p_notifications) <> 'array' then
    raise exception using errcode = '22023', message = 'A lista de notificações precisa ser um array JSON.';
  end if;

  for v_notification in select value from pg_catalog.jsonb_array_elements(p_notifications)
  loop
    v_dedupe_key := pg_catalog.replace(pg_catalog.btrim(coalesce(v_notification->>'dedupe_key', '')), '{{order_ref}}', coalesce(p_order_ref, ''));
    v_phone := pg_catalog.btrim(coalesce(v_notification->>'phone', ''));
    v_message := pg_catalog.replace(coalesce(v_notification->>'message', ''), '{{order_ref}}', coalesce(p_order_ref, ''));
    v_tag := pg_catalog.btrim(coalesce(v_notification->>'tag', ''));

    if v_dedupe_key = '' or pg_catalog.length(v_dedupe_key) > 300 then
      raise exception using errcode = '22023', message = 'A chave idempotente da notificação é inválida.';
    end if;
    if v_phone !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception using errcode = '22023', message = 'O WhatsApp de destino da notificação é inválido.';
    end if;
    if v_message = '' or pg_catalog.length(v_message) > 10000 or v_tag = '' or pg_catalog.length(v_tag) > 100 then
      raise exception using errcode = '22023', message = 'O texto ou a identificação da notificação é inválido.';
    end if;

    insert into public.dashboard_whatsapp_outbox (
      dedupe_key, event_id, event_type, order_ref, recipient_phone_e164, message, tag
    ) values (
      v_dedupe_key, p_event_id, p_event_type, p_order_ref, v_phone, v_message, v_tag
    ) on conflict (dedupe_key) do nothing;

    select id into v_id from public.dashboard_whatsapp_outbox where dedupe_key = v_dedupe_key;
    v_ids := v_ids || pg_catalog.jsonb_build_array(v_id);
  end loop;

  return pg_catalog.jsonb_build_object('ok', true, 'outbox_ids', v_ids);
end;
$$;

create or replace function public.dashboard_process_event_with_outbox(
  p_event_id text,
  p_event_type text,
  p_order_ref text,
  p_payload jsonb,
  p_agenda_rows jsonb,
  p_notifications jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_result jsonb;
  v_row jsonb;
  v_outbox jsonb;
begin
  if p_agenda_rows is null or pg_catalog.jsonb_typeof(p_agenda_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'A lista de agendas precisa ser um array JSON.';
  end if;

  v_result := public.dashboard_process_event(p_event_id, p_event_type, p_order_ref, p_payload);
  if pg_catalog.jsonb_typeof(v_result) = 'object'
     and (v_result->>'ok' = 'false' or v_result->>'success' = 'false' or v_result ? 'error') then
    raise exception using errcode = 'P0001', message = 'O evento não foi aceito pelas regras operacionais.';
  end if;

  for v_row in select value from pg_catalog.jsonb_array_elements(p_agenda_rows)
  loop
    if pg_catalog.jsonb_typeof(v_row) <> 'object'
       or nullif(v_row->>'p_order_ref', '') is null
       or pg_catalog.jsonb_typeof(v_row->'p_sector') is distinct from 'object'
       or nullif(v_row->>'p_planned_start_at', '') is null then
      raise exception using errcode = '22023', message = 'Uma linha da agenda de produção está incompleta.';
    end if;

    perform public.dashboard_upsert_production_agenda(
      v_row->>'p_order_ref',
      v_row->'p_sector',
      (v_row->>'p_planned_start_at')::timestamp with time zone,
      nullif(v_row->>'p_due_at', '')::timestamp with time zone
    );
  end loop;

  v_outbox := public.dashboard_enqueue_whatsapp_outbox(p_event_id, p_event_type, p_order_ref, p_notifications);
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'result', v_result,
    'outbox_ids', v_outbox->'outbox_ids'
  );
end;
$$;

create or replace function public.dashboard_create_order_with_code_and_outbox(
  p_event_id text,
  p_payload jsonb,
  p_notifications jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_created jsonb;
  v_order_ref text;
  v_outbox jsonb;
begin
  v_created := public.dashboard_create_order_with_code(p_event_id, p_payload);
  v_order_ref := v_created->>'order_ref';
  if v_order_ref is null or v_order_ref !~ '^ENC [0-9]{4}\.[0-9]{3}\.[0-9]{3,}$' then
    raise exception using errcode = 'P0001', message = 'O banco não retornou um código de encomenda válido.';
  end if;

  v_outbox := public.dashboard_enqueue_whatsapp_outbox(p_event_id, 'order.created', v_order_ref, p_notifications);
  return v_created || pg_catalog.jsonb_build_object('outbox_ids', v_outbox->'outbox_ids');
end;
$$;

create or replace function public.dashboard_list_whatsapp_outbox_to_publish(p_limit integer default 50)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', q.id) order by q.created_at),
    '[]'::jsonb
  )
  from (
    select id, created_at
    from public.dashboard_whatsapp_outbox
    where status in ('pending', 'queued')
      and available_at <= pg_catalog.now()
      and (status = 'pending' or last_enqueued_at is null or last_enqueued_at < pg_catalog.now() - interval '20 minutes')
    order by created_at
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  ) as q;
$$;

create or replace function public.dashboard_mark_whatsapp_outbox_queued(p_outbox_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated uuid;
begin
  update public.dashboard_whatsapp_outbox
  set status = 'queued', last_enqueued_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where id = p_outbox_id and status in ('pending', 'queued')
  returning id into v_updated;
  return v_updated is not null;
end;
$$;

create or replace function public.dashboard_claim_whatsapp_outbox(p_outbox_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.dashboard_whatsapp_outbox%rowtype;
  v_status text;
begin
  update public.dashboard_whatsapp_outbox
  set status = 'processing', attempts = attempts + 1,
      locked_until = pg_catalog.now() + interval '10 minutes', updated_at = pg_catalog.now()
  where id = p_outbox_id
    and available_at <= pg_catalog.now()
    and (status in ('pending', 'queued') or (status = 'processing' and locked_until < pg_catalog.now()))
  returning * into v_row;

  if found then
    return pg_catalog.to_jsonb(v_row);
  end if;

  select status into v_status from public.dashboard_whatsapp_outbox where id = p_outbox_id;
  if v_status is null then
    raise exception using errcode = 'P0002', message = 'Notificação não encontrada na caixa de saída.';
  end if;
  return pg_catalog.jsonb_build_object('status', v_status);
end;
$$;

create or replace function public.dashboard_complete_whatsapp_outbox(p_outbox_id uuid)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated uuid;
begin
  update public.dashboard_whatsapp_outbox
  set status = 'sent', sent_at = pg_catalog.now(), locked_until = null, last_error = null, updated_at = pg_catalog.now()
  where id = p_outbox_id and status = 'processing'
  returning id into v_updated;
  return v_updated is not null;
end;
$$;

create or replace function public.dashboard_fail_whatsapp_outbox(p_outbox_id uuid, p_error text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.dashboard_whatsapp_outbox%rowtype;
begin
  update public.dashboard_whatsapp_outbox
  set status = case when attempts >= 8 then 'dead' else 'pending' end,
      available_at = pg_catalog.now() + case when attempts >= 8 then interval '0 seconds'
        else pg_catalog.make_interval(secs => least(1800, (60 * pg_catalog.power(2::numeric, greatest(attempts - 1, 0)))::integer)) end,
      locked_until = null,
      last_error = pg_catalog.left(coalesce(p_error, 'Falha desconhecida ao enviar a mensagem.'), 500),
      updated_at = pg_catalog.now()
  where id = p_outbox_id and status = 'processing'
  returning * into v_row;
  if not found then
    raise exception using errcode = 'P0002', message = 'Não foi possível atualizar o estado da notificação.';
  end if;
  return pg_catalog.jsonb_build_object('status', v_row.status, 'attempts', v_row.attempts);
end;
$$;

do $$
declare
  v_agenda_rpc_count integer;
begin
  if pg_catalog.to_regprocedure('public.dashboard_process_event(text,text,text,jsonb)') is null then
    raise exception 'A função public.dashboard_process_event(text,text,text,jsonb) precisa existir antes desta migração.';
  end if;

  -- The deployed RPC has a fifth, defaulted p_status argument. A four-argument
  -- call remains valid, but to_regprocedure() only matches exact signatures.
  select count(*)
    into v_agenda_rpc_count
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
    and p.proargtypes[3] = 'timestamp with time zone'::regtype::oid;

  if v_agenda_rpc_count <> 1 then
    raise exception 'Esperava uma sobrecarga de dashboard_upsert_production_agenda com os quatro argumentos de agenda e p_status padrão; encontrei %.', v_agenda_rpc_count;
  end if;

  if pg_catalog.to_regprocedure('public.dashboard_create_order_with_code(text,jsonb)') is null then
    raise exception 'A função public.dashboard_create_order_with_code(text,jsonb) precisa existir antes desta migração.';
  end if;
end;
$$;

revoke all on function public.dashboard_enqueue_whatsapp_outbox(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.dashboard_process_event_with_outbox(text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.dashboard_create_order_with_code_and_outbox(text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.dashboard_list_whatsapp_outbox_to_publish(integer) from public, anon, authenticated;
revoke all on function public.dashboard_mark_whatsapp_outbox_queued(uuid) from public, anon, authenticated;
revoke all on function public.dashboard_claim_whatsapp_outbox(uuid) from public, anon, authenticated;
revoke all on function public.dashboard_complete_whatsapp_outbox(uuid) from public, anon, authenticated;
revoke all on function public.dashboard_fail_whatsapp_outbox(uuid, text) from public, anon, authenticated;

grant execute on function public.dashboard_enqueue_whatsapp_outbox(text, text, text, jsonb) to service_role;
grant execute on function public.dashboard_process_event_with_outbox(text, text, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.dashboard_create_order_with_code_and_outbox(text, jsonb, jsonb) to service_role;
grant execute on function public.dashboard_list_whatsapp_outbox_to_publish(integer) to service_role;
grant execute on function public.dashboard_mark_whatsapp_outbox_queued(uuid) to service_role;
grant execute on function public.dashboard_claim_whatsapp_outbox(uuid) to service_role;
grant execute on function public.dashboard_complete_whatsapp_outbox(uuid) to service_role;
grant execute on function public.dashboard_fail_whatsapp_outbox(uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
