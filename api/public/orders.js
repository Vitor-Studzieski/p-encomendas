"use strict";

const { createOrderEvent, dispatchEvent } = require("../../lib/events");
const { enforceRateLimit, fail, json, methodNotAllowed, readBody } = require("../../lib/http");
const { getOperationSettings } = require("../../lib/supabase");
const { verifyPublicFormToken } = require("../../lib/public-form-token");

module.exports = async function publicOrders(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!process.env.PUBLIC_ORDER_FORM_TOKEN || process.env.PUBLIC_ORDER_FORM_TOKEN.length < 32) {
    return json(response, 503, { message: "Formulário público ainda não configurado." });
  }
  try {
    if (!await enforceRateLimit(request, response, "public-order-form", 10, 10 * 60)) return;
    const body = await readBody(request);
    if (!verifyPublicFormToken(body.acesso, body.expira)) return json(response, 401, { message: "Link do formulário inválido ou expirado." });
    const settings = await getOperationSettings();
    const event = createOrderEvent({
      event_id: body.event_id,
      order_ref: body.order_ref,
      payload: {
        order: {
          requested_date: body.requested_date,
          requested_time: body.requested_time,
          pickup_location: body.pickup_location,
          fulfillment_type: "pickup",
          notes: body.notes
        },
        customer: { name: body.customer_name, phone_e164: body.customer_phone },
        fiscal: { phone_e164: settings.fiscal_phone_e164 },
        items: body.items
      }
    });
    const result = await dispatchEvent(event);
    return json(response, 202, { ok: true, order_ref: event.order_ref, warnings: result.warnings });
  } catch (error) {
    return fail(response, error, "Não foi possível enviar a encomenda.");
  }
};

