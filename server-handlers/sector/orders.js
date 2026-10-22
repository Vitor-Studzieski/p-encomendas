"use strict";

const { fail, json, methodNotAllowed, readBody, sameOriginRequest } = require("../../lib/http");
const { requirePortalEnabled, sectorContext } = require("../../lib/sector-auth");
const { enforceSectorPortalRateLimit } = require("../../lib/sector-rate-limit");
const { createPortalOrder } = require("../../lib/sector-workflow");
const { rest } = require("../../lib/supabase");

module.exports = async function sectorOrders(request, response) {
  if (!["GET", "POST"].includes(request.method)) return methodNotAllowed(response, ["GET", "POST"]);
  if (request.method === "POST" && !sameOriginRequest(request)) return json(response, 403, { message: "Origem da solicitação inválida." });
  try {
    requirePortalEnabled();
    const context = await sectorContext(request, response);
    if (!context) return json(response, 401, { message: "Entre com a conta da gerência do portal." });
    if (context.account.role !== "manager") return json(response, 403, { message: "Somente a gerência pode acessar as encomendas do portal." });
    if (context.account.must_change_password) return json(response, 428, { message: "Troque a senha inicial antes de acessar as encomendas." });
    if (request.method === "GET") {
      if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-order-list", 120, 60)) return;
      const orders = await rest("/rest/v1/sector_portal_orders?" + new URLSearchParams({
        select: "id,display_id,status,customer_name,requested_date,requested_time,pickup_location,created_at",
        order: "created_at.desc",
        limit: "100"
      }));
      return json(response, 200, { orders: orders || [] });
    }
    if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-orders", 30, 60)) return;
    const body = await readBody(request, 65536);
    const result = await createPortalOrder(context.account, body);
    return json(response, 201, result);
  } catch (error) {
    if (error?.supabaseCode === "23505") return json(response, 409, { message: "Esta encomenda já foi registrada." });
    if (["P0001", "P0002"].includes(error?.supabaseCode)) return json(response, 409, { message: "Os dados da encomenda mudaram ou o setor foi desativado. Atualize a página e tente novamente." });
    if (error?.supabaseCode === "42501") return json(response, 403, { message: "Esta conta não pode cadastrar encomendas." });
    if (["22023", "22007", "22008", "22P02", "22003"].includes(error?.supabaseCode)) return json(response, 422, { message: "Revise os dados da encomenda e tente novamente." });
    if (["PGRST202", "42703", "PGRST204", "PGRST205", "42P01"].includes(error?.supabaseCode)) return json(response, 503, { message: "As tabelas independentes do portal ainda não existem no banco. Execute supabase/sql-editor/create_sector_portal.sql." });
    return fail(response, error, request.method === "GET"
      ? "Não foi possível carregar as encomendas do portal."
      : "Não foi possível cadastrar a encomenda no portal.");
  }
};
