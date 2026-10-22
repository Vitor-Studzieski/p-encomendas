"use strict";

const { fail, json, methodNotAllowed, readBody, sameOriginRequest } = require("../../lib/http");
const { createAuthUser, deleteAuthUser, requirePortalEnabled, sectorContext } = require("../../lib/sector-auth");
const { enforceSectorPortalRateLimit } = require("../../lib/sector-rate-limit");
const { rest } = require("../../lib/supabase");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sectorRecord(row) {
  return Array.isArray(row) ? row[0] || {} : row || {};
}

function accountListRecord(row) {
  const sector = sectorRecord(row.sector);
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    sector_id: row.sector_id || null,
    must_change_password: row.must_change_password === true,
    sector_name: sector.name || (row.role === "fiscal" ? "Fiscal" : row.role === "manager" ? "Gerência do portal" : "Setor"),
    active: row.active === true,
    created_at: row.created_at
  };
}

function missingPortalSchema(error) {
  return ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.supabaseCode);
}

module.exports = async function sectorAccounts(request, response) {
  if (!["GET", "POST", "PATCH"].includes(request.method)) return methodNotAllowed(response, ["GET", "POST", "PATCH"]);
  if (request.method !== "GET" && !sameOriginRequest(request)) return json(response, 403, { message: "Origem da solicitação inválida." });

  try {
    requirePortalEnabled();
    const context = await sectorContext(request, response);
    if (!context) return json(response, 401, { message: "Entre com uma conta da gerência do portal." });
    if (context.account.role !== "manager") return json(response, 403, { message: "Somente a gerência do portal pode administrar contas." });

    if (request.method === "GET") {
      if (!await enforceSectorPortalRateLimit(request, response, "sector-portal-account-list", 120, 60)) return;
      const [sectors, rows] = await Promise.all([
        rest("/rest/v1/sector_portal_sectors?" + new URLSearchParams({ select: "id,name,slug", active: "eq.true", order: "name.asc" })),
        rest("/rest/v1/sector_portal_accounts?" + new URLSearchParams({
          select: "id,email,display_name,role,sector_id,active,must_change_password,created_at,sector:sector_portal_sectors(name,slug)",
          order: "role.asc,email.asc",
          limit: "500"
        }))
      ]);
      return json(response, 200, {
        sectors: (sectors || []).map(({ id, name, slug }) => ({ id, name, slug })),
        accounts: (rows || []).map(accountListRecord)
      });
    }

    if (!await enforceSectorPortalRateLimit(request, response, "sector-account-admin", 20, 60 * 60)) return;
    const body = await readBody(request, 16384);
    if (request.method === "PATCH") {
      const id = String(body.id || "");
      if (!UUID.test(id) || typeof body.active !== "boolean") return json(response, 422, { message: "Informe a conta e o estado que deseja aplicar." });
      if (id === context.account.id && body.active === false) return json(response, 422, { message: "Não é possível suspender a própria conta de gerência." });
      const rows = await rest("/rest/v1/sector_portal_accounts?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: { active: body.active, updated_at: new Date().toISOString() }
      });
      if (!rows?.[0]) return json(response, 404, { message: "Conta de setor não encontrada." });
      return json(response, 200, { account: accountListRecord(rows[0]) });
    }

    const displayName = String(body.display_name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const role = String(body.role || "");
    const sectorId = String(body.sector_id || "");
    if (!displayName || displayName.length > 120 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(response, 422, { message: "Informe nome e e-mail válidos para a conta." });
    }
    if (password.length < 12 || password.length > 128) return json(response, 422, { message: "Use uma senha temporária com pelo menos 12 caracteres." });
    if (!["sector", "fiscal"].includes(role)) return json(response, 422, { message: "Selecione uma função válida." });

    const sectors = await rest("/rest/v1/sector_portal_sectors?" + new URLSearchParams({ select: "id,name,slug", active: "eq.true" }));
    if (role === "sector" && (!UUID.test(sectorId) || !(sectors || []).some(sector => String(sector.id) === sectorId))) {
      return json(response, 422, { message: "Selecione um setor ativo para esta conta." });
    }

    let authUser = null;
    try {
      authUser = await createAuthUser({ email, password, displayName });
      const rows = await rest("/rest/v1/sector_portal_accounts", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: [{
          auth_user_id: authUser.id,
          email: authUser.email,
          display_name: displayName,
          role,
          sector_id: role === "sector" ? sectorId : null,
          must_change_password: true,
          active: true
        }]
      });
      const result = rows?.[0] || {};
      return json(response, 201, {
        account: {
          id: result.id,
          email: result.email,
          display_name: result.display_name,
          role: result.role,
          sector_id: result.sector_id || null,
          sector_name: role === "fiscal" ? "Fiscal" : (sectors.find(sector => String(sector.id) === sectorId)?.name || "Setor"),
          must_change_password: result.must_change_password === true,
          active: result.active === true,
          created_at: result.created_at
        }
      });
    } catch (error) {
      if (authUser?.id) {
        try { await deleteAuthUser(authUser.id); }
        catch { console.error("Falha ao remover conta Auth sem vínculo do portal por setor."); }
      }
      if (error?.authStatus === 409 || /user_already_exists|email_exists|email.*already|already.*email/i.test(String(error?.authCode || "") + " " + String(error?.message || ""))) {
        return json(response, 409, { message: "Esse e-mail já tem uma conta no Supabase. Use outro e-mail ou vincule a conta existente pela configuração do Supabase." });
      }
      if (error?.authStatus === 422) return json(response, 422, { message: "O Supabase não aceitou os dados da conta. Verifique o formato do e-mail e os requisitos de senha configurados." });
      if (error?.supabaseCode === "23505") return json(response, 409, { message: "Já existe uma conta operacional vinculada a esse e-mail." });
      throw error;
    }
  } catch (error) {
    if (missingPortalSchema(error)) {
      return json(response, 503, { message: "O banco ainda não tem as tabelas independentes do portal. Aplique supabase/sql-editor/create_sector_portal.sql." });
    }
    return fail(response, error, "Não foi possível gerenciar as contas dos setores.");
  }
};
