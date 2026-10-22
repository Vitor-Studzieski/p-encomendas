"use strict";

const { fail, json, methodNotAllowed } = require("../../lib/http");
const { requirePortalEnabled, sectorContext } = require("../../lib/sector-auth");
const { enforceSectorPortalRateLimit } = require("../../lib/sector-rate-limit");
const { sectorWorkboard } = require("../../lib/sector-workflow");

module.exports = async function sectorWorkboardHandler(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    requirePortalEnabled();
    const context = await sectorContext(request, response);
    if (!context) return json(response, 401, { message: "Entre com a conta do seu setor." });
    if (context.account.must_change_password) return json(response, 428, { message: "Troque a senha inicial antes de acessar a fila." });
    if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-workboard", 120, 60)) return;
    const result = await sectorWorkboard(context.account);
    const { auth_user_id: _internalId, ...account } = context.account;
    return json(response, 200, { account, ...result });
  } catch (error) {
    if (["PGRST202", "42703", "PGRST204", "PGRST205", "42P01"].includes(error?.supabaseCode)) {
      return json(response, 503, { message: "As tabelas independentes do portal ainda não existem no banco. Execute supabase/sql-editor/create_sector_portal.sql." });
    }
    return fail(response, error, "Não foi possível carregar a fila deste setor.");
  }
};
