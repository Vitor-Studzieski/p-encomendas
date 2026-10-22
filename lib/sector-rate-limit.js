"use strict";

const crypto = require("node:crypto");
const { json } = require("./http");
const { rpc } = require("./supabase");

function clientAddress(request) {
  const forwarded = request.headers?.["x-forwarded-for"] || request.headers?.["x-real-ip"];
  const address = String(forwarded || request.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return address.slice(0, 100) || "unknown";
}

async function enforceSectorPortalRateLimit(request, response, scope, maxHits, windowSeconds) {
  try {
    const secret = process.env.SECTOR_SESSION_SECRET || "";
    if (secret.length < 32) throw new Error("A chave de sessão do portal não está configurada.");
    const fingerprint = crypto.createHmac("sha256", secret)
      .update(scope + "\0" + clientAddress(request))
      .digest("hex");
    const result = await rpc("sector_portal_consume_rate_limit", {
      p_fingerprint: fingerprint,
      p_scope: scope,
      p_max_hits: maxHits,
      p_window_seconds: windowSeconds
    });
    const row = Array.isArray(result) ? result[0] : result;
    if (typeof row?.allowed !== "boolean") throw new Error("A proteção contra abuso do portal não respondeu corretamente.");
    if (row.allowed) return true;
    response.setHeader("Retry-After", String(Math.max(1, Number(row.retry_after_seconds) || windowSeconds)));
    json(response, 429, { message: "Muitas tentativas. Aguarde um pouco e tente novamente." });
    return false;
  } catch (error) {
    console.error("Rate limit independente indisponível para " + scope + ".");
    json(response, 503, { message: "Proteção do portal temporariamente indisponível. Tente novamente em instantes." });
    return false;
  }
}

module.exports = { enforceSectorPortalRateLimit };
