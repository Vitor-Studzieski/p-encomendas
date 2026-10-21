-- Read-only: reproduce the text replacements from
-- 20261021084158_normalize_product_size_selection.sql against the live RPC.
-- This identifies which exact replacement fails without changing the database.

with routine as (
  select pg_catalog.pg_get_functiondef(
    'public.dashboard_process_event(text,text,text,jsonb)'::regprocedure
  ) as definition
),
normalized as (
  select
    definition,
    replace(definition, E'\r\n', E'\n') as normalized_definition
  from routine
),
source_patterns as (
  select
    $decl$  v_size_label text;$decl$ as old_declaration,
    E'  v_size_label text;\n  v_size_ref text;\n  v_product_size_id uuid;' as new_declaration,
    $assignment$        v_size_label := nullif(trim(coalesce(
          v_item->>'size_label',
          v_item->>'size'
        )), '');$assignment$ as old_assignment,
    $assignment_new$        v_size_label := nullif(trim(coalesce(
          v_item->>'size_label',
          v_item->>'size'
        )), '');
        v_size_ref := nullif(trim(coalesce(
          v_item->>'product_size_id',
          v_item->>'size_id'
        )), '');
        if v_size_ref is not null and v_size_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception using errcode = '22023', message = 'O tamanho selecionado é inválido.';
        end if;
        v_product_size_id := case when v_size_ref is null then null else v_size_ref::uuid end;$assignment_new$ as new_assignment,
    $columns$          size_label,
          sector_id,$columns$ as old_columns,
    $columns_new$          size_label,
          product_size_id,
          sector_id,$columns_new$ as new_columns,
    $values$          v_size_label,
          v_sector_id,$values$ as old_values,
    $values_new$          v_size_label,
          v_product_size_id,
          v_sector_id,$values_new$ as new_values
),
after_declaration as (
  select
    n.definition as original_definition,
    n.normalized_definition,
    p.*,
    replace(n.normalized_definition, p.old_declaration, p.new_declaration) as after_declaration
  from normalized n cross join source_patterns p
),
after_assignment as (
  select *, replace(after_declaration, old_assignment, new_assignment) as after_assignment
  from after_declaration
),
after_columns as (
  select *, replace(after_assignment, old_columns, new_columns) as after_columns
  from after_assignment
),
after_values as (
  select *, replace(after_columns, old_values, new_values) as after_values
  from after_columns
)
select
  pg_catalog.strpos(original_definition, E'\r\n') > 0 as fonte_tem_crlf,
  pg_catalog.strpos(normalized_definition, old_assignment) > 0 as leitura_tamanho_encontrada_apos_normalizar,
  after_declaration <> normalized_definition as declaracao_encontrada,
  after_assignment <> after_declaration as leitura_tamanho_substituida,
  after_columns <> after_assignment as colunas_insert_substituidas,
  after_values <> after_columns as valores_insert_substituidos
from after_values;
