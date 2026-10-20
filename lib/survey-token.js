"use strict";

const crypto = require("node:crypto");

function signSurveyToken(orderRef, expires) {
  const secret = process.env.SURVEY_SIGNING_SECRET;
  if (!secret || secret.length < 32) throw Object.assign(new Error("SURVEY_SIGNING_SECRET precisa ter pelo menos 32 caracteres."), { statusCode: 503 });
  const value = String(orderRef) + "." + String(expires);
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function verifySurveyToken(orderRef, expires, signature) {
  const expiry = Number(expires);
  if (!Number.isInteger(expiry) || expiry < Math.floor(Date.now() / 1000) || expiry > Math.floor(Date.now() / 1000) + 32 * 24 * 60 * 60) return false;
  try {
    const expected = signSurveyToken(orderRef, expiry);
    const actual = String(signature || "");
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

module.exports = { signSurveyToken, verifySurveyToken };

