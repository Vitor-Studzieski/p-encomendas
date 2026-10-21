"use strict";

const crypto = require("node:crypto");

function surveySecret() {
  const secret = process.env.SURVEY_SIGNING_SECRET;
  if (!secret || secret.length < 32) throw Object.assign(new Error("SURVEY_SIGNING_SECRET precisa ter pelo menos 32 caracteres."), { statusCode: 503 });
  return secret;
}

function surveyKey() {
  return crypto.createHash("sha256").update(surveySecret()).digest();
}

function signSurveyToken(orderRef, expires) {
  const value = String(orderRef) + "." + String(expires);
  return crypto.createHmac("sha256", surveySecret()).update(value).digest("base64url");
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

function createSurveyToken(orderRef, expires) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", surveyKey(), iv);
  const plaintext = Buffer.from(JSON.stringify({ order_ref: String(orderRef), expires: Number(expires) }));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv, encrypted, cipher.getAuthTag()].map(value => value.toString("base64url")).join(".");
}

function decryptSurveyToken(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const [iv, encrypted, authTag] = parts.map(value => Buffer.from(value, "base64url"));
    if (iv.length !== 12 || authTag.length !== 16 || !encrypted.length) return null;

    const decipher = crypto.createDecipheriv("aes-256-gcm", surveyKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const value = JSON.parse(plaintext.toString("utf8"));
    const orderRef = typeof value.order_ref === "string" ? value.order_ref : "";
    const expires = Number(value.expires);
    const now = Math.floor(Date.now() / 1000);
    if (!orderRef || !Number.isInteger(expires) || expires < now || expires > now + 32 * 24 * 60 * 60) return null;
    return { orderRef, expires };
  } catch {
    return null;
  }
}

module.exports = { createSurveyToken, decryptSurveyToken, signSurveyToken, verifySurveyToken };

