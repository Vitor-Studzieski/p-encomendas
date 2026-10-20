"use strict";

const { fail, json, methodNotAllowed, requireDashboard } = require("../lib/http");
const { getProductionAgenda } = require("../lib/supabase");

module.exports = async function productionAgenda(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  if (!await requireDashboard(request, response)) return;
  try {
    return json(response, 200, { data: await getProductionAgenda() });
  } catch (error) {
    return fail(response, error, "Não foi possível carregar o andamento por setor.");
  }
};
