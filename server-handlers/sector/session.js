"use strict";

const { fail, json, methodNotAllowed, readBody, sameOriginRequest } = require("../../lib/http");
const { publicMembership, requirePortalEnabled, sectorContext, signIn, signOut } = require("../../lib/sector-auth");
const { enforceSectorPortalRateLimit } = require("../../lib/sector-rate-limit");

module.exports = async function sectorSession(request, response) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) return methodNotAllowed(response, ["GET", "POST", "DELETE"]);

  if (request.method === "GET") {
    try {
      requirePortalEnabled();
      if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-session-check", 120, 60)) return;
      const context = await sectorContext(request, response);
      return json(response, 200, {
        authenticated: Boolean(context),
        ...(context ? { account: publicMembership(context.account) } : {})
      });
    } catch (error) {
      if (error?.statusCode === 503) return json(response, 503, { message: error.message });
      return fail(response, error, "Não foi possível consultar o acesso ao portal por setor.");
    }
  }

  if (!sameOriginRequest(request)) return json(response, 403, { message: "Origem da solicitação inválida." });

  if (request.method === "DELETE") {
    try {
      await signOut(request, response);
      return json(response, 200, { authenticated: false });
    } catch (error) {
      return fail(response, error, "Não foi possível encerrar a sessão do setor.");
    }
  }

  try {
    requirePortalEnabled();
    if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-auth", 8, 10 * 60)) return;
    const body = await readBody(request, 8192);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 1 || password.length > 256) {
      return json(response, 422, { message: "Informe o e-mail e a senha da equipe." });
    }
    const result = await signIn(email, password, response);
    return json(response, 200, { authenticated: true, account: result.account });
  } catch (error) {
    if ([401, 403, 422].includes(error.statusCode)) return json(response, error.statusCode, { message: error.message });
    if (error?.statusCode === 503) return json(response, 503, { message: error.message });
    return fail(response, error, "Não foi possível entrar no portal por setor.");
  }
};
