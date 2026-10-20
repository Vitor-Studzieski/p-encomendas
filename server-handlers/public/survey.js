"use strict";

const { dispatchEvent } = require("../../lib/events");
const { enforceRateLimit, fail, json, methodNotAllowed, readBody } = require("../../lib/http");
const { verifySurveyToken } = require("../../lib/survey-token");

module.exports = async function publicSurvey(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  try {
    if (!await enforceRateLimit(request, response, "public-survey", 20, 10 * 60)) return;
    const body = await readBody(request);
    const orderRef = String(body.order_ref || "");
    const expires = Number(body.expires);
    if (!orderRef || !verifySurveyToken(orderRef, expires, body.signature)) {
      return json(response, 401, { message: "Link da pesquisa inválido ou expirado." });
    }
    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json(response, 422, { message: "Escolha uma nota de 1 a 5." });
    const event = {
      event_id: String(body.event_id || "survey:" + orderRef + ":" + expires),
      event_type: "survey.response",
      order_ref: orderRef,
      payload: { survey: { rating, comment: String(body.comment || "").trim().slice(0, 1000), submitted_at: new Date().toISOString() } }
    };
    const result = await dispatchEvent(event);
    return json(response, 200, { ok: true, warnings: result.warnings });
  } catch (error) {
    return fail(response, error, "Não foi possível registrar a avaliação.");
  }
};

