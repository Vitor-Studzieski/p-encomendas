-- Keep production WhatsApp routing separate for each item sector.
alter table public.dashboard_operation_settings
  add column if not exists confectionery_phone_e164 text not null default '',
  add column if not exists rotisserie_phone_e164 text not null default '';

notify pgrst, 'reload schema';
