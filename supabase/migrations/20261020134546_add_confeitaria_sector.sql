-- Add a single confectionery production sector without changing existing sectors.
insert into public.sectors (name, slug, active, sort_order)
select 'Confeitaria', 'confeitaria', true, 20
where not exists (
  select 1
  from public.sectors
  where lower(coalesce(slug, '')) = 'confeitaria'
     or lower(name) = 'confeitaria'
);
