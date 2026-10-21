-- Read-only: show the actual product/size parsing and order_items INSERT
-- from the database copy of dashboard_process_event.

with routine as (
  select pg_catalog.pg_get_functiondef(
    'public.dashboard_process_event(text,text,text,jsonb)'::regprocedure
  ) as definition
),
lines as (
  select x.line_number, x.line
  from routine r
  cross join lateral regexp_split_to_table(r.definition, E'\n')
    with ordinality as x(line, line_number)
),
matches as (
  select line_number
  from lines
  where line ilike '%v_size_label%'
     or line ilike '%v_item->>%'
     or line ilike '%order_items%'
)
select distinct l.line_number, l.line
from lines l
where exists (
  select 1
  from matches m
  where l.line_number between m.line_number - 4 and m.line_number + 8
)
order by l.line_number;
