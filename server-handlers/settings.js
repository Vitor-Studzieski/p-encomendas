"use strict";

const { fail, json, methodNotAllowed, readBody, requireDashboard } = require("../lib/http");
const { normalizePhone } = require("../lib/phones");
const { getOperationSettings, saveOperationSettings } = require("../lib/supabase");

module.exports = async function settings(request, response) {
  if (!["GET", "PUT"].includes(request.method)) return methodNotAllowed(response, ["GET", "PUT"]);
  if (!await requireDashboard(request, response)) return;
  try {
    if (request.method === "GET") {
      return json(response, 200, { data: await getOperationSettings() });
    }
    const body = await readBody(request);
    const inputs = {
      bakery_phone_e164: String(body.bakery_phone_e164 || "").trim(),
      fiscal_phone_e164: String(body.fiscal_phone_e164 || "").trim(),
      customer_phone_e164: String(body.customer_phone_e164 || "").trim(),
      butcher_phone_e164: String(body.butcher_phone_e164 || "").trim(),
      cold_cuts_phone_e164: String(body.cold_cuts_phone_e164 || "").trim()
    };
    const invalidField = Object.entries(inputs).find(([, value]) => value && !normalizePhone(value));
    if (invalidField) {
      const labels = {
        bakery_phone_e164: "Padaria",
        fiscal_phone_e164: "Fiscal",
        customer_phone_e164: "Cliente",
        butcher_phone_e164: "Açougue",
        cold_cuts_phone_e164: "Frios"
      };
      return json(response, 422, { message: "O WhatsApp de " + labels[invalidField[0]] + " precisa ter DDD e ser válido, ou ficar vazio." });
    }
    const settings = Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, normalizePhone(value)]));
    const data = await saveOperationSettings(settings);
    return json(response, 200, { data });
  } catch (error) {
    return fail(response, error, "Não foi possível salvar os telefones da operação.");
  }
};

