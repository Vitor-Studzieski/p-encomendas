"use strict";

const { fail, json, methodNotAllowed, readBody, sameOriginRequest } = require("../../lib/http");
const { requirePortalEnabled, sectorContext } = require("../../lib/sector-auth");
const { enforceSectorPortalRateLimit } = require("../../lib/sector-rate-limit");
const { applySectorAction } = require("../../lib/sector-workflow");

module.exports = async function sectorActions(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!sameOriginRequest(request)) return json(response, 403, { message: "Origem da solicitação inválida." });
  try {
    requirePortalEnabled();
    if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-actions", 90, 60)) return;
    const context = await sectorContext(request, response);
    if (!context) return json(response, 401, { message: "Entre com a conta do seu setor." });
    if (context.account.must_change_password) return json(response, 428, { message: "Troque a senha inicial antes de atualizar pedidos." });
    const body = await readBody(request, 16384);
    const result = await applySectorAction(context.account, body);
    return json(response, 200, result);
  } catch (error) {
    if (error?.supabaseCode === "P0001") return json(response, 409, { message: "O pedido mudou de etapa ou já foi encerrado. Atualize a fila e tente novamente." });
    if (error?.supabaseCode === "P0002" || error?.supabaseCode === "23505") return json(response, 409, { message: "A análise ou ação já foi registrada. Atualize a fila." });
    if (error?.supabaseCode === "42501") return json(response, 403, { message: "Esta conta não tem permissão para executar essa ação." });
    if (error?.supabaseCode === "22023") return json(response, 422, { message: "Os dados da ação são inválidos. Revise as informações e tente novamente." });
    if (["PGRST202", "42703", "PGRST204", "PGRST205", "42P01"].includes(error?.supabaseCode)) {
      return json(response, 503, { message: "As tabelas independentes do portal ainda não existem no banco. Execute supabase/sql-editor/create_sector_portal.sql." });
    }
    return fail(response, error, "Não foi possível atualizar a encomenda no portal do setor.");
  }
};
