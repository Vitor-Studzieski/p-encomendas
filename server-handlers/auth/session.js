"use strict";

const { enforceRateLimit, hasDashboardSession, json, methodNotAllowed, readBody, sameOriginRequest, sameSecret, setDashboardSession } = require("../../lib/http");

module.exports = async function dashboardSession(request, response) {
  if (request.method === "GET") {
    return json(response, 200, { authenticated: hasDashboardSession(request) });
  }

  if (request.method !== "POST" && request.method !== "DELETE") {
    return methodNotAllowed(response, ["GET", "POST", "DELETE"]);
  }

  if (!sameOriginRequest(request)) return json(response, 403, { message: "Origem da solicitação inválida." });

  if (request.method === "DELETE") {
    setDashboardSession(response, false);
    return json(response, 200, { authenticated: false });
  }

  const expected = process.env.DASHBOARD_ACCESS_TOKEN;
  if (!expected || expected.length < 32) {
    return json(response, 503, { message: "A autenticação da dashboard ainda não está configurada no servidor." });
  }
  if (!await enforceRateLimit(request, response, "dashboard-auth", 8, 10 * 60)) return;

  try {
    const body = await readBody(request, 4096);
    if (!sameSecret(body.token, expected)) return json(response, 401, { message: "Credencial de acesso inválida." });
    setDashboardSession(response, true);
    return json(response, 200, { authenticated: true, expiresIn: 30 * 24 * 60 * 60 });
  } catch (error) {
    return json(response, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { message: error.message || "Não foi possível iniciar a sessão." });
  }
};
