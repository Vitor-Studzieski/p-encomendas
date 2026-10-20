"use strict";

const { fail, json, methodNotAllowed, requireDashboard } = require("../lib/http");
const { getOrders } = require("../lib/supabase");

module.exports = async function orders(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  if (!await requireDashboard(request, response)) return;
  try {
    return json(response, 200, { data: await getOrders() });
  } catch (error) {
    return fail(response, error, "Não foi possível carregar os pedidos do Supabase.");
  }
};

