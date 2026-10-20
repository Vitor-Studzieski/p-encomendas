"use strict";

const crypto = require("node:crypto");

const DASHBOARD_SESSION_COOKIE = "dashboard_session";
const DASHBOARD_SESSION_SECONDS = 30 * 24 * 60 * 60;
const DASHBOARD_SESSION_RENEW_BELOW_SECONDS = 7 * 24 * 60 * 60;

function json(response, status, payload) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  };
  if (typeof response.status === "function" && typeof response.json === "function") {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    return response.status(status).json(payload);
  }
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, { ...headers, "Content-Length": body.length });
  response.end(body);
}

function methodNotAllowed(response, methods) {
  const value = methods.join(", ");
  if (typeof response.setHeader === "function") response.setHeader("Allow", value);
  return json(response, 405, { message: "Método não permitido." });
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const contentType = String(request.headers?.["content-type"] || "");
  if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw Object.assign(new Error("Envie o corpo no formato JSON."), { statusCode: 415 });
  }
  const declaredLength = Number(request.headers?.["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw Object.assign(new Error("Payload muito grande."), { statusCode: 413 });
  }

  if (request.body !== undefined) {
    if (typeof request.body === "string" || Buffer.isBuffer(request.body)) {
      const raw = Buffer.isBuffer(request.body) ? request.body.toString("utf8") : request.body;
      if (Buffer.byteLength(raw) > maxBytes) throw Object.assign(new Error("Payload muito grande."), { statusCode: 413 });
      try { return raw ? JSON.parse(raw) : {}; }
      catch { throw Object.assign(new Error("JSON inválido."), { statusCode: 400 }); }
    }
    if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
      throw Object.assign(new Error("O corpo precisa ser um objeto JSON."), { statusCode: 400 });
    }
    let serialized;
    try { serialized = JSON.stringify(request.body); }
    catch { throw Object.assign(new Error("O corpo JSON não é válido."), { statusCode: 400 }); }
    if (typeof serialized !== "string") throw Object.assign(new Error("O corpo JSON não é válido."), { statusCode: 400 });
    if (Buffer.byteLength(serialized) > maxBytes) throw Object.assign(new Error("Payload muito grande."), { statusCode: 413 });
    return request.body;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Payload muito grande."), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error("JSON inválido."), { statusCode: 400 });
  }
}

function sameSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dashboardSessionKey() {
  const secret = process.env.DASHBOARD_ACCESS_TOKEN;
  if (!secret || secret.length < 32) return null;
  return crypto.createHmac("sha256", secret).update("dashboard-session-v1").digest();
}

function signDashboardSession(payload) {
  const key = dashboardSessionKey();
  if (!key) return null;
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", key).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function readCookie(request, name) {
  const cookies = String(request.headers?.cookie || "").split(";");
  for (const entry of cookies) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(entry.slice(separator + 1).trim()); }
    catch { return ""; }
  }
  return "";
}

function readDashboardSession(request) {
  const value = readCookie(request, DASHBOARD_SESSION_COOKIE);
  const separator = value.lastIndexOf(".");
  const key = dashboardSessionKey();
  if (!key || separator < 1) return null;
  const encoded = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expectedSignature = crypto.createHmac("sha256", key).update(encoded).digest("base64url");
  if (!sameSecret(signature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload?.v === 1 && Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

function hasDashboardSession(request) {
  return Boolean(readDashboardSession(request));
}

function renewDashboardSession(request, response) {
  const session = readDashboardSession(request);
  if (!session) return false;
  if (session.exp - Math.floor(Date.now() / 1000) < DASHBOARD_SESSION_RENEW_BELOW_SECONDS) setDashboardSession(response, true);
  return true;
}

function setDashboardSession(response, active) {
  const secure = process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  const attributes = [`${DASHBOARD_SESSION_COOKIE}=${active ? encodeURIComponent(signDashboardSession({ v: 1, exp: Math.floor(Date.now() / 1000) + DASHBOARD_SESSION_SECONDS })) : ""}`, "Path=/", "HttpOnly", "SameSite=Strict"];
  if (active) attributes.push(`Max-Age=${DASHBOARD_SESSION_SECONDS}`);
  else attributes.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (secure) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function sameOriginRequest(request) {
  const origin = request.headers?.origin;
  const host = request.headers?.["x-forwarded-host"] || request.headers?.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.host.toLowerCase() !== String(host).toLowerCase()) return false;
    const forwardedProto = String(request.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
    return !forwardedProto || parsed.protocol === `${forwardedProto}:`;
  } catch {
    return false;
  }
}

async function enforceRateLimit(request, response, scope, maxHits, windowSeconds) {
  try {
    const { consumeRateLimit } = require("./rate-limit");
    const result = await consumeRateLimit(request, scope, maxHits, windowSeconds);
    if (result.allowed) return true;
    response.setHeader("Retry-After", String(result.retryAfter));
    json(response, 429, { message: "Muitas tentativas. Aguarde um pouco e tente novamente." });
    return false;
  } catch (error) {
    console.error("Rate limit indisponível para " + scope + ".");
    json(response, 503, { message: "Proteção temporariamente indisponível. Tente novamente em instantes." });
    return false;
  }
}

async function requireDashboard(request, response) {
  const expected = process.env.DASHBOARD_ACCESS_TOKEN;
  if (!expected || expected.length < 32) {
    json(response, 503, { message: "Configure um DASHBOARD_ACCESS_TOKEN com pelo menos 32 caracteres." });
    return false;
  }
  if (hasDashboardSession(request)) {
    if (!await enforceRateLimit(request, response, "dashboard-api", 180, 60)) return false;
    renewDashboardSession(request, response);
    return true;
  }
  if (!await enforceRateLimit(request, response, "dashboard-auth", 8, 10 * 60)) return false;
  json(response, 401, { message: "Sessão da dashboard inválida ou expirada." });
  return false;
}

function requireCron(request, response) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers?.authorization || "";
  if (!secret || secret.length < 32) {
    json(response, 503, { message: "Configure um CRON_SECRET com pelo menos 32 caracteres." });
    return false;
  }
  if (!sameSecret(authorization, `Bearer ${secret}`)) {
    json(response, 401, { message: "Acesso negado." });
    return false;
  }
  return true;
}

function fail(response, error, context = "Não foi possível concluir a operação.") {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(`${context}: ${error?.message || "erro interno"}`);
  return json(response, status, { message: status >= 500 ? context : (error?.message || context) });
}

module.exports = { enforceRateLimit, fail, hasDashboardSession, json, methodNotAllowed, readBody, requireCron, requireDashboard, renewDashboardSession, sameOriginRequest, sameSecret, setDashboardSession };
