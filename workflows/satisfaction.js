"use strict";

const { sleep } = require("workflow");

async function satisfactionSurvey(orderRef) {
  "use workflow";
  await sleep("2h");
  return sendSatisfactionMessage(orderRef);
}

async function sendSatisfactionMessage(orderRef) {
  "use step";
  const { getOrderByReference } = require("../lib/supabase");
  const { normalizePhone } = require("../lib/phones");
  const { sendText } = require("../lib/zapi");
  const { createSurveyToken } = require("../lib/survey-token");

  const order = await getOrderByReference(orderRef);
  const phone = normalizePhone(order?.customer_phone || order?.customer?.phone_e164);
  if (!phone) return { sent: false, reason: "customer_phone_missing" };

  const base = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("APP_BASE_URL não foi configurada.");
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  const token = createSurveyToken(orderRef, expires);
  const link = base + "/avaliacao.html#token=" + encodeURIComponent(token);
  await sendText(phone, "Como foi sua experiência com nosso atendimento e sua encomenda? Conte para nós nesta pesquisa rápida: " + link);
  return { sent: true, orderRef };
}

module.exports = { satisfactionSurvey };

