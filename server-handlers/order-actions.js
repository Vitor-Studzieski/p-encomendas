"use strict";

const { actionEvent, dispatchEvent, requestFiscalReview } = require("../lib/events");
const { fail, json, methodNotAllowed, readBody, requireDashboard } = require("../lib/http");

module.exports = async function orderActions(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!await requireDashboard(request, response)) return;
  try {
    const body = await readBody(request);
    if (body.action === "reject" && body.fiscal_review_complete !== true) {
      throw Object.assign(new Error("Confirme que a Fiscal concluiu a análise antes de encerrar o pedido."), { statusCode: 422 });
    }
    const result = body.action === "request_review"
      ? await requestFiscalReview(body.external_order_id || body.order_ref, body.reason || "", body.event_id)
      : await dispatchEvent(actionEvent(body));
    return json(response, 200, result);
  } catch (error) {
    return fail(response, error, "Não foi possível atualizar o pedido.");
  }
};

