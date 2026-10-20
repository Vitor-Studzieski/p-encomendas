"use strict";

const crypto = require("node:crypto");
const { rpc } = require("./supabase");

function clientAddress(request) {
  const forwarded = request.headers?.["x-forwarded-for"] || request.headers?.["x-real-ip"];
  const address = String(forwarded || request.socket?.remoteAddress || "unknown").split(",")[0].trim();
  return address.slice(0, 100) || "unknown";
}

async function consumeRateLimit(request, scope, maxHits, windowSeconds) {
  const fingerprintSecret = process.env.SURVEY_SIGNING_SECRET;
  if (!fingerprintSecret || fingerprintSecret.length < 32) {
    throw Object.assign(new Error("A chave interna de proteção contra abuso não está configurada."), { statusCode: 503 });
  }
  const fingerprint = crypto.createHmac("sha256", fingerprintSecret)
    .update(scope + "\0" + clientAddress(request))
    .digest("hex");
  const result = await rpc("consume_dashboard_rate_limit", {
    p_fingerprint: fingerprint,
    p_scope: scope,
    p_max_hits: maxHits,
    p_window_seconds: windowSeconds
  });
  const row = Array.isArray(result) ? result[0] : result;
  if (typeof row?.allowed !== "boolean") {
    throw Object.assign(new Error("O serviço de proteção contra abuso não respondeu corretamente."), { statusCode: 503 });
  }
  return {
    allowed: row.allowed,
    retryAfter: Math.max(1, Number(row.retry_after_seconds) || windowSeconds)
  };
}

module.exports = { consumeRateLimit };
