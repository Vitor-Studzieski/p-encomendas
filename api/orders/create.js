"use strict";

const { createOrderEvent, dispatchEvent } = require("../../lib/events");
const { fail, json, methodNotAllowed, readBody, requireDashboard } = require("../../lib/http");

module.exports = async function createOrder(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!await requireDashboard(request, response)) return;
  try {
    const result = await dispatchEvent(createOrderEvent(await readBody(request)));
    return json(response, 202, result);
  } catch (error) {
    return fail(response, error, "Não foi possível registrar a encomenda.");
  }
};

