"use strict";

const crypto = require("node:crypto");

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_FUTURE_SECONDS = 8 * 24 * 60 * 60;

function formSecret() {
  const secret = process.env.PUBLIC_ORDER_FORM_TOKEN;
  if (!secret || secret.length < 32) {
    throw Object.assign(new Error("PUBLIC_ORDER_FORM_TOKEN precisa ter pelo menos 32 caracteres."), { statusCode: 503 });
  }
  return secret;
}

function sign(expiresAt) {
  return crypto.createHmac("sha256", formSecret())
    .update("fiscal-order-form:" + String(expiresAt))
    .digest("base64url");
}

function createPublicFormToken(now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + TOKEN_TTL_SECONDS;
  return { access: sign(expiresAt), expiresAt };
}

function verifyPublicFormToken(access, expiresAt, now = Date.now()) {
  const current = Math.floor(now / 1000);
  const expiry = Number(expiresAt);
  if (!Number.isInteger(expiry) || expiry <= current || expiry > current + MAX_FUTURE_SECONDS) return false;
  try {
    const expected = Buffer.from(sign(expiry));
    const actual = Buffer.from(String(access || ""));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = { createPublicFormToken, verifyPublicFormToken };
