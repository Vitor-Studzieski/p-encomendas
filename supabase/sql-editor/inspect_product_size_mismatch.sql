-- Read-only: expose line endings and compare the live RPC text with the
-- exact multi-line snippets expected by the size migration.

with routine as (
  select pg_catalog.pg_get_functiondef(
    'public.dashboard_process_event(text,text,text,jsonb)'::regprocedure
  ) as definition
), normalized as (
  select
    definition,
    replace(definition, E'\r\n', E'\n') as normalized_definition
  from routine
), patterns as (
  select
    $assignment$        v_size_label := nullif(trim(coalesce(
          v_item->>'size_label',
          v_item->>'size'
        )), '');$assignment$ as expected_assignment,
    $columns$          size_label,
          sector_id,$columns$ as expected_columns,
    $values$          v_size_label,
          v_sector_id,$values$ as expected_values
), locations as (
  select
    n.*,
    p.*,
    pg_catalog.strpos(n.normalized_definition, 'v_size_label :=') as assignment_start,
    pg_catalog.strpos(n.normalized_definition, 'insert into public.order_items') as insert_start
  from normalized n cross join patterns p
)
select
  pg_catalog.strpos(normalized_definition, E'\r') > 0 as sobra_cr_apos_normalizacao,
  pg_catalog.strpos(normalized_definition, expected_assignment) > 0 as leitura_exata_encontrada,
  pg_catalog.strpos(
    pg_catalog.regexp_replace(normalized_definition, '[[:space:]]+', ' ', 'g'),
    pg_catalog.regexp_replace(expected_assignment, '[[:space:]]+', ' ', 'g')
  ) > 0 as leitura_apos_normalizar_espacos,
  pg_catalog.strpos(normalized_definition, expected_columns) > 0 as colunas_exatas_encontradas,
  pg_catalog.strpos(normalized_definition, expected_values) > 0 as valores_exatos_encontrados,
  replace(replace(replace(substring(normalized_definition from assignment_start for 180), E'\r', '<CR>'), E'\n', '<LF>'), E'\t', '<TAB>') as trecho_leitura_visivel,
  encode(convert_to(substring(normalized_definition from assignment_start for 180), 'UTF8'), 'hex') as trecho_leitura_hex,
  replace(replace(replace(substring(normalized_definition from insert_start for 320), E'\r', '<CR>'), E'\n', '<LF>'), E'\t', '<TAB>') as trecho_insert_visivel
from locations;
