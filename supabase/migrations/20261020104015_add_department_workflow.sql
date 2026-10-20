-- Add dedicated contacts and production sectors for meat and cold cuts.
alter table public.dashboard_operation_settings
  add column if not exists butcher_phone_e164 text not null default '',
  add column if not exists cold_cuts_phone_e164 text not null default '';

update public.sectors
set active = true,
    sort_order = case when lower(coalesce(slug, '')) = 'acougue' or lower(name) in ('açougue', 'acougue') then 30 else 40 end,
    updated_at = now()
where lower(coalesce(slug, '')) in ('acougue', 'frios')
   or lower(name) in ('açougue', 'acougue', 'frios');

insert into public.sectors (name, slug, active, sort_order)
select 'Açougue', 'acougue', true, 30
where not exists (
  select 1 from public.sectors where lower(coalesce(slug, '')) = 'acougue' or lower(name) in ('açougue', 'acougue')
);

insert into public.sectors (name, slug, active, sort_order)
select 'Frios', 'frios', true, 40
where not exists (
  select 1 from public.sectors where lower(coalesce(slug, '')) = 'frios' or lower(name) = 'frios'
);
