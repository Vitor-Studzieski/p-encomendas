-- Keep order-review state private while allowing the trusted server to read it.
begin;

do $$
begin
  if to_regclass('public.dashboard_automation_audit') is null then
    raise exception 'A tabela public.dashboard_automation_audit não existe.';
  end if;
end;
$$;

alter table public.dashboard_automation_audit enable row level security;
revoke all on table public.dashboard_automation_audit from public, anon, authenticated;
grant select, insert on table public.dashboard_automation_audit to service_role;

commit;
