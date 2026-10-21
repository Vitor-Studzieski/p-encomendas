"use strict";

const DEFAULT_SUPABASE_URL = "https://ztwrqyvamsgzrpidhide.supabase.co";

function supabaseCredentials() {
  const configuredUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw Object.assign(new Error("SUPABASE_SERVICE_ROLE_KEY não foi configurada na Vercel."), { statusCode: 503 });
  let url;
  try { url = new URL(configuredUrl); }
  catch { throw Object.assign(new Error("SUPABASE_URL não é válida."), { statusCode: 503 }); }
  const isLocalHttp = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const allowLocalHttp = !process.env.VERCEL && url.protocol === "http:" && isLocalHttp;
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !allowLocalHttp)) {
    throw Object.assign(new Error("SUPABASE_URL deve usar HTTPS e não pode incluir credenciais."), { statusCode: 503 });
  }
  return { baseUrl: url.toString().replace(/\/$/, ""), serviceKey };
}

function classifySupabaseError(code, data) {
  if (code !== "P0002") return undefined;
  const message = String(data?.message || "");
  if (/Produto ativo não encontrado/i.test(message)) return "product_not_found";
  if (/Setor não encontrado/i.test(message)) return "sector_not_found";
  if (/Pedido não encontrado/i.test(message)) return "order_not_found";
  return "unclassified_p0002";
}

async function rest(path, options = {}) {
  const { baseUrl, serviceKey } = supabaseCredentials();
  const url = new URL(path.replace(/^\//, ""), `${baseUrl}/`);
  const headers = new Headers(options.headers || {});
  headers.set("apikey", serviceKey);
  headers.set("Authorization", `Bearer ${serviceKey}`);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw Object.assign(new Error("Não foi possível conectar ao Supabase."), { statusCode: 502, cause: error });
  }

  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { data = raw; }
  }
  if (!response.ok) {
    const code = typeof data?.code === "string" ? data.code : "unknown";
    const category = classifySupabaseError(code, data);
    const operation = url.pathname.replace(/^\/rest\/v1\//, "");
    const isCatalogValidationError = ["P0001", "P0002", "22023", "23503"].includes(code);
    console.error("Supabase Data API request failed.", {
      operation,
      method: String(options.method || "GET").toUpperCase(),
      status: response.status,
      code,
      ...(category ? { category } : {})
    });
    throw Object.assign(new Error(isCatalogValidationError
      ? "Um produto, tamanho ou setor não corresponde mais ao catálogo. Atualize a página e revise o pedido."
      : "Não foi possível concluir a operação de dados."), {
      statusCode: isCatalogValidationError ? 422 : 502,
      supabaseCode: code,
      supabaseOperation: operation,
      ...(category ? { supabaseCategory: category } : {})
    });
  }
  return data;
}

function rpc(name, body) {
  return rest(`/rest/v1/rpc/${encodeURIComponent(name)}`, { method: "POST", body });
}

function isMissingColumn(error) {
  return error?.supabaseCode === "42703" || error?.supabaseCode === "PGRST204";
}

async function getOrders() {
  const query = new URLSearchParams({
    select: "id,display_id,status,requested_date,requested_time,delivery_address,due_at,created_at,customer_name,customer_phone,items_summary,sector_name",
    order: "requested_date.asc,requested_time.asc"
  });
  return rest(`/rest/v1/dashboard_orders?${query}`);
}

async function getOperationSettings() {
  const defaults = { setting_key: "operation", bakery_phone_e164: "", fiscal_phone_e164: "", customer_phone_e164: "", butcher_phone_e164: "", cold_cuts_phone_e164: "" };
  const query = new URLSearchParams({ select: "setting_key,bakery_phone_e164,fiscal_phone_e164,customer_phone_e164,butcher_phone_e164,cold_cuts_phone_e164,updated_at", setting_key: "eq.operation", limit: "1" });
  try {
    const rows = await rest(`/rest/v1/dashboard_operation_settings?${query}`);
    return { ...defaults, ...(rows?.[0] || {}) };
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    const legacyQuery = new URLSearchParams({ select: "setting_key,bakery_phone_e164,fiscal_phone_e164,customer_phone_e164,updated_at", setting_key: "eq.operation", limit: "1" });
    const rows = await rest(`/rest/v1/dashboard_operation_settings?${legacyQuery}`);
    return { ...defaults, ...(rows?.[0] || {}) };
  }
}

async function getActiveSectors() {
  const query = new URLSearchParams({ select: "id,name,slug,sort_order", active: "eq.true", order: "sort_order.asc,name.asc" });
  return rest(`/rest/v1/sectors?${query}`);
}

async function getActiveProducts() {
  const query = new URLSearchParams({ select: "id,name,category,unit,sizes:product_sizes(id,label,sort_order,active)", active: "eq.true", order: "name.asc", limit: "500" });
  query.set("sizes.order", "sort_order.asc,label.asc");
  return rest(`/rest/v1/products?${query}`);
}

async function getProductionAgenda() {
  const query = new URLSearchParams({
    select: "id,order_id,sector_id,production_date,status,items,planned_start_at,due_at,actual_start_at,actual_completed_at,sector:sectors!inner(name,slug),order:orders!inner(id,external_order_id,requested_date,requested_time,status,customer:customers(name,phone_e164))",
    "order.status": "not.in.(picked_up,rejected,cancelled)",
    order: "production_date.asc,due_at.asc",
    limit: "500"
  });
  return rest(`/rest/v1/production_agenda?${query}`);
}

async function saveOperationSettings(settings) {
  const query = new URLSearchParams({ on_conflict: "setting_key" });
  const options = {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: [{ setting_key: "operation", ...settings, updated_at: new Date().toISOString() }]
  };
  try {
    const rows = await rest(`/rest/v1/dashboard_operation_settings?${query}`, options);
    return rows?.[0] || { setting_key: "operation", ...settings };
  } catch (error) {
    if (!isMissingColumn(error)) throw error;
    if (settings.butcher_phone_e164 || settings.cold_cuts_phone_e164) {
      throw Object.assign(new Error("O Supabase ainda não tem as colunas de Açougue e Frios. Aplique a migração 20261020104015_add_department_workflow.sql para salvar esses contatos."), { statusCode: 503 });
    }
    const legacySettings = {
      bakery_phone_e164: settings.bakery_phone_e164 || "",
      fiscal_phone_e164: settings.fiscal_phone_e164 || "",
      customer_phone_e164: settings.customer_phone_e164 || ""
    };
    const rows = await rest(`/rest/v1/dashboard_operation_settings?${query}`, {
      ...options,
      body: [{ setting_key: "operation", ...legacySettings, updated_at: new Date().toISOString() }]
    });
    return { ...(rows?.[0] || { setting_key: "operation", ...legacySettings }), butcher_phone_e164: "", cold_cuts_phone_e164: "" };
  }
}

async function upsertCustomer(name, phone) {
  const query = new URLSearchParams({ on_conflict: "phone_e164" });
  const rows = await rest(`/rest/v1/customers?${query}`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: [{ name, phone_e164: phone }]
  });
  return rows?.[0] || null;
}

async function audit(entry) {
  return rest("/rest/v1/dashboard_automation_audit", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: entry
  });
}

async function claimAutomationRun(jobKey, jobType, reference) {
  const result = await rpc("claim_dashboard_automation", {
    p_job_key: jobKey,
    p_job_type: jobType,
    p_reference: reference
  });
  return result === true;
}

async function updateAutomationRun(jobKey, status, details = {}) {
  const query = new URLSearchParams({ job_key: `eq.${jobKey}` });
  return rest(`/rest/v1/dashboard_automation_runs?${query}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: { status, details, completed_at: new Date().toISOString() }
  });
}

async function getOrderByReference(reference) {
  const query = new URLSearchParams({
    select: "*,customer:customers(*),items:order_items(*,product:products(name),sector:sectors(id,name,slug))",
    external_order_id: `eq.${reference}`,
    limit: "1"
  });
  let rows = await rest(`/rest/v1/orders?${query}`);
  if (rows?.[0]) return rows[0];

  const byId = new URLSearchParams({ select: "*,customer:customers(*),items:order_items(*,product:products(name),sector:sectors(id,name,slug))", id: `eq.${reference}`, limit: "1" });
  rows = await rest(`/rest/v1/orders?${byId}`);
  if (rows?.[0]) return rows[0];

  const viewQuery = new URLSearchParams({ select: "*", display_id: `eq.${reference}`, limit: "1" });
  rows = await rest(`/rest/v1/dashboard_orders?${viewQuery}`);
  return rows?.[0] || null;
}

async function getOrderItems(orderId) {
  const query = new URLSearchParams({ select: "*", order_id: `eq.${orderId}` });
  return rest(`/rest/v1/order_items?${query}`);
}

async function getSummaryOrders(fromDate, toDate) {
  const query = new URLSearchParams({
    select: "display_id,status,requested_date,requested_time,items_summary,sector_name",
    and: `(requested_date.gte.${fromDate},requested_date.lte.${toDate})`,
    order: "requested_date.asc,requested_time.asc"
  });
  query.append("status", "not.in.(picked_up,rejected,cancelled)");
  return rest(`/rest/v1/dashboard_orders?${query}`);
}

module.exports = { audit, claimAutomationRun, getActiveProducts, getActiveSectors, getOperationSettings, getOrderByReference, getOrderItems, getOrders, getProductionAgenda, getSummaryOrders, rest, rpc, saveOperationSettings, updateAutomationRun, upsertCustomer };
