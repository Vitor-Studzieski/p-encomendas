"use strict";

const crypto = require("node:crypto");
const { rest } = require("./supabase");
const { sameSecret } = require("./http");

const COOKIE_NAME = "sector_portal_session";
const SESSION_AGE_SECONDS = 30 * 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

function authConfiguration() {
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const sessionSecret = process.env.SECTOR_SESSION_SECRET || "";
  if (!baseUrl || !publishableKey || !serviceKey || sessionSecret.length < MIN_SECRET_LENGTH) {
    throw Object.assign(new Error("O portal por setor ainda não foi configurado no servidor."), { statusCode: 503 });
  }
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch { throw Object.assign(new Error("SUPABASE_URL não é válida."), { statusCode: 503 }); }
  const localHttp = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) && parsed.protocol === "http:" && !process.env.VERCEL;
  if (parsed.protocol !== "https:" && !localHttp) {
    throw Object.assign(new Error("SUPABASE_URL precisa usar HTTPS."), { statusCode: 503 });
  }
  return { baseUrl: parsed.toString().replace(/\/$/, ""), publishableKey, serviceKey, sessionSecret };
}

async function authFetch(path, { method = "GET", body, accessToken, admin = false } = {}) {
  const config = authConfiguration();
  const key = admin ? config.serviceKey : config.publishableKey;
  const url = new URL("/auth/v1/" + String(path || "").replace(/^\//, ""), config.baseUrl);
  const headers = new Headers({ apikey: key, Accept: "application/json" });
  if (accessToken) headers.set("Authorization", "Bearer " + accessToken);
  else if (admin) headers.set("Authorization", "Bearer " + config.serviceKey);
  if (body !== undefined) headers.set("Content-Type", "application/json");
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    throw Object.assign(new Error("Não foi possível conectar à autenticação do Supabase."), { statusCode: 502, cause: error });
  }
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { data = null; }
  }
  if (!response.ok) {
    const error = new Error(String(data?.msg || data?.message || data?.error_description || data?.error || "Falha de autenticação."));
    error.authStatus = response.status;
    error.authCode = String(data?.code || data?.error_code || "");
    error.statusCode = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return data;
}

function signPayload(payload) {
  const { sessionSecret } = authConfiguration();
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  return encoded + "." + signature;
}

function parsePayload(value) {
  const { sessionSecret } = authConfiguration();
  const separator = String(value || "").lastIndexOf(".");
  if (separator < 1) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = crypto.createHmac("sha256", sessionSecret).update(encoded).digest("base64url");
  if (!sameSecret(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload?.v !== 1 || typeof payload.userId !== "string" || !payload.userId ||
        typeof payload.accessToken !== "string" || !payload.accessToken ||
        typeof payload.refreshToken !== "string" || !payload.refreshToken ||
        !Number.isInteger(payload.expiresAt)) return null;
    return payload;
  } catch { return null; }
}

function cookieValue(request) {
  for (const entry of String(request.headers?.cookie || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== COOKIE_NAME) continue;
    try { return decodeURIComponent(entry.slice(separator + 1).trim()); }
    catch { return ""; }
  }
  return "";
}

function setSectorCookie(response, payload) {
  const secure = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  const value = payload ? signPayload(payload) : "";
  if (value.length > 3800) throw Object.assign(new Error("A sessão do setor excede o limite seguro do navegador."), { statusCode: 503 });
  const attributes = [
    COOKIE_NAME + "=" + (payload ? encodeURIComponent(value) : ""),
    "Path=/", "HttpOnly", "SameSite=Strict",
    payload ? "Max-Age=" + SESSION_AGE_SECONDS : "Max-Age=0",
    ...(payload ? [] : ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"])
  ];
  if (secure) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function sessionFromRequest(request) {
  const raw = cookieValue(request);
  if (!raw) return null;
  try { return parsePayload(raw); }
  catch { return null; }
}

async function refreshSession(session) {
  const result = await authFetch("token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: session.refreshToken }
  });
  return {
    v: 1,
    userId: session.userId,
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Number(result.expires_at) || Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600)
  };
}

async function membershipFor(userId) {
  const query = new URLSearchParams({
    select: "id,auth_user_id,email,display_name,role,sector_id,active,must_change_password,sector:sector_portal_sectors(id,name,slug)",
    auth_user_id: "eq." + userId,
    active: "eq.true",
    limit: "1"
  });
  try {
    const rows = await rest("/rest/v1/sector_portal_accounts?" + query);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    if (["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(error?.supabaseCode)) {
      throw Object.assign(new Error("O banco ainda não tem as tabelas independentes do portal por setor. Aplique supabase/sql-editor/create_sector_portal.sql."), { statusCode: 503, cause: error });
    }
    throw error;
  }
}

function publicMembership(record) {
  const sector = Array.isArray(record?.sector) ? record.sector[0] || {} : record?.sector || {};
  return {
    id: record.id,
    email: record.email,
    display_name: record.display_name,
    role: record.role,
    sector_id: record.sector_id || null,
    must_change_password: record.must_change_password === true,
    sector_name: sector.name || record.sector_name || (record.role === "fiscal" ? "Fiscal" : record.role === "manager" ? "Gerência" : "Setor")
  };
}

async function sectorContext(request, response) {
  let session;
  try { session = sessionFromRequest(request); }
  catch (error) { return null; }
  if (!session) return null;
  try {
    if (session.expiresAt - Math.floor(Date.now() / 1000) < 120) {
      session = await refreshSession(session);
      setSectorCookie(response, session);
    }
    const user = await authFetch("user", { accessToken: session.accessToken });
    if (!user?.id || String(user.id) !== session.userId) {
      setSectorCookie(response, null);
      return null;
    }
    const account = await membershipFor(user.id);
    if (!account) {
      setSectorCookie(response, null);
      return null;
    }
    return {
      user: { id: user.id, email: user.email || account.email },
      account: { ...publicMembership(account), auth_user_id: user.id },
      session
    };
  } catch (error) {
    if ([400, 401, 403].includes(error?.authStatus)) {
      setSectorCookie(response, null);
      return null;
    }
    throw error;
  }
}

async function signIn(email, password, response) {
  let authResult;
  try {
    authResult = await authFetch("token?grant_type=password", {
      method: "POST",
      body: { email, password }
    });
  } catch (error) {
    if ([400, 401].includes(error?.authStatus)) {
      throw Object.assign(new Error("E-mail ou senha inválidos."), { statusCode: 401 });
    }
    throw error;
  }
  if (!authResult?.access_token || !authResult?.refresh_token || !authResult?.user?.id) {
    throw Object.assign(new Error("E-mail ou senha inválidos."), { statusCode: 401 });
  }
  const session = {
    v: 1,
    userId: String(authResult.user.id),
    accessToken: String(authResult.access_token),
    refreshToken: String(authResult.refresh_token),
    expiresAt: Number(authResult.expires_at) || Math.floor(Date.now() / 1000) + Number(authResult.expires_in || 3600)
  };
  const account = await membershipFor(session.userId);
  if (!account) {
    try { await authFetch("logout", { method: "POST", accessToken: session.accessToken }); } catch { /* The account has no app access; discard the Auth session. */ }
    throw Object.assign(new Error("Esta conta ainda não tem acesso ao portal. Fale com a gerência."), { statusCode: 403 });
  }
  setSectorCookie(response, session);
  return { user: { id: session.userId, email: authResult.user.email || account.email }, account: publicMembership(account) };
}

async function signOut(request, response) {
  let session = null;
  try { session = sessionFromRequest(request); }
  catch { /* Always clear the browser cookie even if the portal secret is unavailable. */ }
  if (session) {
    try { await authFetch("logout", { method: "POST", accessToken: session.accessToken }); }
    catch { /* Always clear this browser's session, even if the provider is unavailable. */ }
  }
  setSectorCookie(response, null);
}

function requirePortalEnabled() {
  if (String(process.env.SECTOR_PORTAL_ENABLED || "").toLowerCase() !== "true") {
    throw Object.assign(new Error("O portal por setor está desligado até a ativação planejada."), { statusCode: 503 });
  }
}

async function createAuthUser({ email, password, displayName }) {
  const result = await authFetch("admin/users", {
    method: "POST",
    admin: true,
    body: { email, password, email_confirm: true, user_metadata: { display_name: displayName } }
  });
  if (!result?.id) throw Object.assign(new Error("O Supabase não retornou o usuário criado."), { statusCode: 502 });
  return { id: String(result.id), email: String(result.email || email).toLowerCase() };
}

async function updateAuthPassword(accessToken, password) {
  return authFetch("user", { method: "PUT", accessToken, body: { password } });
}

async function deleteAuthUser(userId) {
  const response = await authFetch("admin/users/" + encodeURIComponent(userId), { method: "DELETE", admin: true });
  return response;
}

module.exports = {
  authFetch,
  createAuthUser,
  deleteAuthUser,
  membershipFor,
  publicMembership,
  requirePortalEnabled,
  sectorContext,
  setSectorCookie,
  signIn,
  signOut,
  updateAuthPassword
};
