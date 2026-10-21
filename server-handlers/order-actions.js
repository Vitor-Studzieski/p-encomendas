"use strict";

const { actionEvent, dispatchEvent, requestFiscalReview } = require("../lib/events");
const { fail, json, methodNotAllowed, readBody, requireDashboard } = require("../lib/http");
const { hasProductionRefusal } = require("../lib/supabase");

module.exports = async function orderActions(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!await requireDashboard(request, response)) return;
  try {
    const body = await readBody(request);
    if (body.action === "reject") {
      throw Object.assign(new Error("A conclusão de que não será possível produzir deve ser registrada pela Fiscal no WhatsApp, após a análise."), { statusCode: 422 });
    }
    if (body.action === "accept" && !await hasProductionRefusal(body.external_order_id || body.order_ref)) {
      throw Object.assign(new Error("A confirmação pela Dashboard só fica disponível depois que o setor registra a recusa inicial pelo WhatsApp."), { statusCode: 422 });
    }
    const result = body.action === "request_review"
      ? await requestFiscalReview(body.external_order_id || body.order_ref, body.reason || "", body.event_id)
      : await dispatchEvent(actionEvent(body));
    return json(response, 200, result);
  } catch (error) {
    return fail(response, error, "Não foi possível atualizar o pedido.");
  }
};

