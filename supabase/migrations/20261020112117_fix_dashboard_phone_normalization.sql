-- Provide the Brazilian E.164 normalizer used by dashboard_process_event.
-- Keep the behavior aligned with lib/phones.js: accept 10/11 digit national
-- numbers or 55-prefixed numbers and return an empty string for invalid input.

begin;

grant usage on schema private to service_role;

create or replace function private.dashboard_normalize_phone(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  with normalized as (
    select pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits
  )
  select case
    when digits ~ '^55[0-9]{10,11}$' then '+' || digits
    when digits ~ '^[0-9]{10,11}$' then '+55' || digits
    else ''
  end
  from normalized;
$$;

revoke all on function private.dashboard_normalize_phone(text) from public, anon, authenticated;
grant execute on function private.dashboard_normalize_phone(text) to service_role;

notify pgrst, 'reload schema';

commit;
