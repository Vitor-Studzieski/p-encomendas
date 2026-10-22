"use strict";

const { enforceRateLimit, fail, json, methodNotAllowed, readBody, requireDashboard, sameOriginRequest } = require("../lib/http");
const { rpc } = require("../lib/supabase");

module.exports = async function clearOrders(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!await requireDashboard(request, response)) return;
  if (!sameOriginRequest(request)) return json(response, 403, { message: "A solicitação precisa vir da dashboard autenticada." });
  if (!await enforceRateLimit(request, response, "dashboard-clear-orders", 3, 10 * 60)) return;

  try {
    const body = await readBody(request);
    if (body.confirm !== true) return json(response, 400, { message: "Confirme a limpeza dos pedidos antes de continuar." });

    let result;
    try {
      result = await rpc("dashboard_clear_all_orders", {});
    } catch (error) {
      if (["PGRST202", "42883"].includes(error?.supabaseCode)) {
        return json(response, 503, { message: "Aplique primeiro a migração 20261022011733_dashboard_clear_all_orders.sql no Supabase." });
      }
      throw error;
    }

    const payload = Array.isArray(result) ? result[0] : result;
    return json(response, 200, {
      ok: true,
      deleted_orders: Number(payload?.deleted_orders || 0),
      deleted_history: Number(payload?.deleted_order_items || 0) + Number(payload?.deleted_audit_entries || 0) + Number(payload?.deleted_agenda_rows || 0) + Number(payload?.deleted_automation_runs || 0),
      deleted_order_items: Number(payload?.deleted_order_items || 0),
      deleted_audit_entries: Number(payload?.deleted_audit_entries || 0),
      deleted_agenda_rows: Number(payload?.deleted_agenda_rows || 0),
      deleted_automation_runs: Number(payload?.deleted_automation_runs || 0)
    });
  } catch (error) {
    return fail(response, error, "Não foi possível limpar as encomendas.");
  }
};
