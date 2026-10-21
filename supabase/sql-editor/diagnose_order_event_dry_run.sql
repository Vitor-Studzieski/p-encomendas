-- Diagnose public.dashboard_process_event without keeping an order or event.
-- Run the entire script in the Supabase SQL Editor. The result is returned as
-- a row because the editor does not show RAISE NOTICE messages consistently.
-- The inner exception block rolls back any writes made by dashboard_process_event.

create temporary table if not exists codex_dry_run_result (
  resultado text,
  sqlstate text,
  mensagem text
);

truncate table pg_temp.codex_dry_run_result;

do $$
declare
  v_result jsonb;
  v_state text;
  v_message text;
  v_event_id text := 'codex-dryrun-' || gen_random_uuid()::text;
  v_order_ref text := 'ENC-DRYRUN-' || gen_random_uuid()::text;
  v_fiscal_phone text := '';
begin
  select coalesce(s.fiscal_phone_e164, '')
    into v_fiscal_phone
  from public.dashboard_operation_settings as s
  where s.setting_key = 'operation'
  limit 1;

  -- Match the service role used by the API's Supabase RPC call.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  begin
    v_result := public.dashboard_process_event(
      v_event_id,
      'order.created',
      v_order_ref,
      jsonb_build_object(
        'order', jsonb_build_object(
          'id', v_order_ref,
          'requested_date', '2026-10-21',
          'requested_time', '12:00',
          'pickup_location', 'Balcão — diagnóstico',
          'fulfillment_type', 'pickup',
          'notes', 'DRY RUN — rollback garantido'
        ),
        'customer', jsonb_build_object(
          'name', 'Cliente diagnóstico Codex',
          'phone_e164', '+5514997787717'
        ),
        'fiscal', jsonb_build_object('phone_e164', v_fiscal_phone),
        'items', jsonb_build_array(jsonb_build_object(
          'product_id', '05cb8620-095f-4fcf-882f-999b9f90bcc9',
          'name', 'BOLO DE CENOURA 700g',
          'quantity', 1,
          'size_label', '700g',
          'sector_id', 'ecea3cb6-8ee7-428c-8257-c9124c5b221b',
          'sector', 'Confeitaria'
        ))
      )
    );

    -- Force rollback even when the function succeeds.
    raise exception using
      errcode = 'P0001',
      message = '__CODEX_DRYRUN_SUCCESS__';
  exception when others then
    get stacked diagnostics
      v_state = returned_sqlstate,
      v_message = message_text;

    if v_message = '__CODEX_DRYRUN_SUCCESS__' then
      insert into pg_temp.codex_dry_run_result (resultado, sqlstate, mensagem)
      values ('SUCCESS', null, 'A função aceitou o evento; qualquer gravação foi revertida.');
    else
      insert into pg_temp.codex_dry_run_result (resultado, sqlstate, mensagem)
      values ('ERROR', v_state, v_message);
    end if;
  end;
end;
$$;

select resultado, sqlstate, mensagem
from pg_temp.codex_dry_run_result;
