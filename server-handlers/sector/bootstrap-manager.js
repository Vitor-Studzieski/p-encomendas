"use strict";

const { fail, json, methodNotAllowed, readBody, sameOriginRequest, sameSecret } = require("../../lib/http");
const { createAuthUser, deleteAuthUser, requirePortalEnabled } = require("../../lib/sector-auth");
const { enforceSectorPortalRateLimit } = require("../../lib/sector-rate-limit");
const { rest } = require("../../lib/supabase");

function missingPortalSchema(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.supabaseCode);
}

async function managerExists() {
  const query = new URLSearchParams({ select: "id", role: "eq.manager", limit: "1" });
  const rows = await rest("/rest/v1/sector_portal_accounts?" + query);
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = async function bootstrapManager(request, response) {
  if (!["GET", "POST"].includes(request.method)) return methodNotAllowed(response, ["GET", "POST"]);
  if (request.method === "POST" && !sameOriginRequest(request)) return json(response, 403, { message: "Origem da solicitação inválida." });

  let authUser = null;
  try {
    requirePortalEnabled();
    const scope = request.method === "GET" ? "sector-portal-manager-bootstrap-status" : "sector-portal-manager-bootstrap";
    const limit = request.method === "GET" ? 120 : 5;
    const windowSeconds = request.method === "GET" ? 60 : 60 * 60;
    if (!await enforceSectorPortalRateLimit(request, response, scope, limit, windowSeconds)) return;

    const available = !(await managerExists());
    if (request.method === "GET") {
      return json(response, 200, {
        available,
        setupConfigured: (process.env.SECTOR_MANAGER_BOOTSTRAP_TOKEN || "").length >= 32
      });
    }

    if (!available) return json(response, 409, { message: "O primeiro acesso da gerência já foi criado. Entre com a conta existente." });
    const setupToken = process.env.SECTOR_MANAGER_BOOTSTRAP_TOKEN || "";
    if (setupToken.length < 32) {
      return json(response, 503, { message: "Configure SECTOR_MANAGER_BOOTSTRAP_TOKEN com pelo menos 32 caracteres no servidor." });
    }

    const body = await readBody(request, 8192);
    if (!sameSecret(String(body.setup_token || ""), setupToken)) return json(response, 401, { message: "Token de configuração inválido." });

    const displayName = String(body.display_name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!displayName || displayName.length > 120 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(response, 422, { message: "Informe nome e e-mail válidos para a conta de gerência." });
    }
    if (password.length < 12 || password.length > 128) {
      return json(response, 422, { message: "Use uma senha com pelo menos 12 caracteres." });
    }

    authUser = await createAuthUser({ email, password, displayName });
    const rows = await rest("/rest/v1/sector_portal_accounts", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: [{
        auth_user_id: authUser.id,
        email: authUser.email,
        display_name: displayName,
        role: "manager",
        sector_id: null,
        must_change_password: false,
        active: true
      }]
    });
    if (!rows?.[0]) throw Object.assign(new Error("A conta foi criada no Auth, mas não foi vinculada ao portal."), { statusCode: 502 });
    return json(response, 201, { created: true, email: rows[0].email });
  } catch (error) {
    if (authUser?.id) {
      try { await deleteAuthUser(authUser.id); }
      catch { console.error("Falha ao remover usuário Auth sem conta inicial de gerência vinculada."); }
    }
    if (missingPortalSchema(error)) {
      return json(response, 503, { message: "As tabelas do portal ainda não estão disponíveis no Supabase. Aplique a migração independente do portal por setor." });
    }
    if (error?.supabaseCode === "23505") {
      return json(response, 409, { message: "O primeiro acesso da gerência já foi criado. Entre com a conta existente." });
    }
    if ([401, 422].includes(error?.authStatus)) {
      return json(response, 422, { message: "O Supabase não aceitou os dados de acesso. Confira o e-mail e os requisitos de senha." });
    }
    if (error?.statusCode === 503) return json(response, 503, { message: error.message });
    return fail(response, error, "Não foi possível criar o primeiro acesso de gerência.");
  }
};
