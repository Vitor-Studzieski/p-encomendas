"use strict";

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const e164Digits = digits.startsWith("55") ? digits : `55${digits}`;
  if (!/^55\d{10,11}$/.test(e164Digits)) return "";
  return `+${e164Digits}`;
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

module.exports = { normalizePhone, phoneDigits };
