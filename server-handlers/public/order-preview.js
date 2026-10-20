"use strict";

const { enforceRateLimit, fail, json, methodNotAllowed, readBody } = require("../../lib/http");
const { resolveOrderText } = require("../../lib/order-text-parser");
const { getActiveProducts, getActiveSectors } = require("../../lib/supabase");
const { verifyPublicFormToken } = require("../../lib/public-form-token");

module.exports = async function publicOrderPreview(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!process.env.PUBLIC_ORDER_FORM_TOKEN || process.env.PUBLIC_ORDER_FORM_TOKEN.length < 32) {
    return json(response, 503, { message: "Formulário público ainda não configurado." });
  }
  try {
    if (!await enforceRateLimit(request, response, "public-order-preview", 60, 10 * 60)) return;
    const body = await readBody(request);
    if (!verifyPublicFormToken(body.acesso, body.expira)) return json(response, 401, { message: "Link do formulário inválido ou expirado." });
    const [products, sectors] = await Promise.all([getActiveProducts(), getActiveSectors()]);
    const confectionerySector = (sectors || []).find(sector => String(sector.slug || "").toLowerCase() === "confeitaria");
    const items = resolveOrderText(body.order_text, products || [], confectionerySector);
    return json(response, 200, { data: { sector: confectionerySector.name, items } });
  } catch (error) {
    return fail(response, error, "Não foi possível identificar os produtos do pedido.");
  }
};
