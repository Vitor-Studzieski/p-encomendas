-- Somente leitura. Mostra todas as sobrecargas da rotina de agenda e seus corpos.
-- Execute no Supabase SQL Editor e exporte/cole o resultado antes de reaplicar
-- 20261022103016_atomic_order_event_and_agenda.sql.
select
  p.oid::regprocedure as assinatura,
  pg_catalog.pg_get_function_identity_arguments(p.oid) as argumentos,
  p.proargnames as nomes_dos_argumentos,
  pg_catalog.pg_get_function_result(p.oid) as retorno,
  p.pronargdefaults as quantidade_de_defaults,
  l.lanname as linguagem,
  case when p.prosecdef then 'DEFINER' else 'INVOKER' end as seguranca,
  pg_catalog.pg_get_functiondef(p.oid) as definicao
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_language l on l.oid = p.prolang
where n.nspname = 'public'
  and p.proname = 'dashboard_upsert_production_agenda'
order by p.pronargs, pg_catalog.pg_get_function_identity_arguments(p.oid);
