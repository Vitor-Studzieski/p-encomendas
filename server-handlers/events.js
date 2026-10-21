"use strict";

const { dispatchEvent } = require("../lib/events");
const { fail, json, methodNotAllowed, readBody, requireDashboard } = require("../lib/http");
const { hasProductionRefusal } = require("../lib/supabase");

module.exports = async function events(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!await requireDashboard(request, response)) return;
  try {
    const event = await readBody(request);
    if (event.event_type === "order.rejected") {
      throw Object.assign(new Error("O encerramento final do pedido deve ser registrado pela Fiscal no WhatsApp após a análise."), { statusCode: 422 });
    }
    if (event.event_type === "order.confirmed" && !await hasProductionRefusal(event.order_ref)) {
      throw Object.assign(new Error("A confirmação pela Dashboard só fica disponível depois que o setor registra a recusa inicial pelo WhatsApp."), { statusCode: 422 });
    }
    const result = await dispatchEvent(event);
    return json(response, 202, result);
  } catch (error) {
    return fail(response, error, "Não foi possível processar o evento.");
  }
};

