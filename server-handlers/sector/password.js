"use strict";

const { fail, json, methodNotAllowed, readBody, sameOriginRequest } = require("../../lib/http");
const { requirePortalEnabled, sectorContext, updateAuthPassword } = require("../../lib/sector-auth");
const { enforceSectorPortalRateLimit } = require("../../lib/sector-rate-limit");
const { rest } = require("../../lib/supabase");

module.exports = async function sectorPassword(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!sameOriginRequest(request)) return json(response, 403, { message: "Origem da solicitação inválida." });
  try {
    requirePortalEnabled();
    if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-password", 5, 15 * 60)) return;
    const context = await sectorContext(request, response);
    if (!context) return json(response, 401, { message: "Entre novamente com a conta do seu setor." });
    const body = await readBody(request, 8192);
    const password = String(body.password || "");
    if (password.length < 12 || password.length > 128) {
      return json(response, 422, { message: "A nova senha precisa ter entre 12 e 128 caracteres." });
    }
    await updateAuthPassword(context.session.accessToken, password);
    await rest("/rest/v1/sector_portal_accounts?auth_user_id=eq." + encodeURIComponent(context.user.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: { must_change_password: false, updated_at: new Date().toISOString() }
    });
    return json(response, 200, { ok: true });
  } catch (error) {
    if (error?.authStatus === 422) return json(response, 422, { message: "O Supabase não aceitou a nova senha. Verifique os requisitos de senha da operação." });
    return fail(response, error, "Não foi possível atualizar a senha da conta.");
  }
};
