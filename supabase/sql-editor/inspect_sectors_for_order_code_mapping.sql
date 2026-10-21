-- Inspect the current sector catalog before assigning numeric order codes.
select
  id,
  name,
  slug,
  active,
  sort_order,
  lower(btrim(coalesce(slug, ''))) as normalized_slug,
  lower(btrim(name)) as normalized_name
from public.sectors
order by sort_order nulls last, name;
