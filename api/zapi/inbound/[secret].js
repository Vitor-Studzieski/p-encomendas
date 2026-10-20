"use strict";

const crypto = require("node:crypto");
const { dispatchEvent, requestFiscalReview } = require("../../../lib/events");
const { enforceRateLimit, fail, json, methodNotAllowed, readBody, sameSecret } = require("../../../lib/http");
const { normalizePhone } = require("../../../lib/phones");
const { getOperationSettings } = require("../../../lib/supabase");
const { sendText } = require("../../../lib/zapi");

function requestSecret(request) {
  if (request.query?.secret) return Array.isArray(request.query.secret) ? request.query.secret[0] : request.query.secret;
  const match = String(request.url || "").match(/^\/api\/zapi\/inbound\/([^/?]+)/);
  return match ? match[1] : "";
}

function inboundPhone(payload) {
  return normalizePhone(payload.phone || payload.chatId || payload.participantPhone);
}

module.exports = async function zapiInbound(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  const expected = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expected || !/^[A-Za-z0-9_-]{32,160}$/.test(expected)) {
    return json(response, 503, { message: "Configure um ZAPI_WEBHOOK_SECRET URL-safe com pelo menos 32 caracteres." });
  }
  if (!sameSecret(requestSecret(request), expected)) return json(response, 404, { message: "Não encontrado." });

  try {
    if (!await enforceRateLimit(request, response, "zapi-inbound", 300, 60)) return;
    const payload = await readBody(request, 512 * 1024);
    if (payload.fromMe || payload.isGroup || payload.isNewsletter || payload.status !== "RECEIVED") {
      return json(response, 200, { ok: true, ignored: true });
    }
    const phone = inboundPhone(payload);
    const text = String(payload.text?.message || payload.message || "").trim();
    if (!phone || !text || text.length > 2000) return json(response, 200, { ok: true, ignored: true });

    const settings = await getOperationSettings();
    const sender = phone.replace(/\D/g, "");
    const bakery = normalizePhone(settings.bakery_phone_e164).replace(/\D/g, "");
    const fiscal = normalizePhone(settings.fiscal_phone_e164).replace(/\D/g, "");
    const command = text.match(/^\s*(CONFIRMAR|RECUSAR|ENCERRAR)\s+(.+?)\s*$/i);

    if (command && ["CONFIRMAR", "RECUSAR"].includes(command[1].toUpperCase()) && sender === bakery) {
      const orderRef = command[2].trim();
      if (orderRef.length > 180) return json(response, 200, { ok: true, ignored: true });
      if (command[1].toUpperCase() === "RECUSAR") {
        const review = await requestFiscalReview(orderRef);
        const reply = review.warnings.length
          ? "O pedido " + orderRef + " continua pendente para revisão, mas não consegui confirmar o aviso à fiscal. Avise a operação diretamente."
          : "A fiscal foi avisada sobre o pedido " + orderRef + ". Ele continua pendente enquanto ela investiga. Se for possível atender, envie CONFIRMAR " + orderRef + ". Se não for possível, a fiscal avisará o cliente. Não registre uma nova encomenda para essa revisão.";
        await sendText(phone, reply, { replyTo: payload.messageId });
        return json(response, 200, { ok: true, review_requested: true, warnings: review.warnings });
      }
      const candidateMessageId = payload.messageId || payload.zaapId;
      const messageId = typeof candidateMessageId === "string" && candidateMessageId.length <= 100
        ? candidateMessageId
        : crypto.randomUUID();
      const result = await dispatchEvent({
        event_id: "zapi-reply:" + messageId,
        event_type: "order.confirmed",
        order_ref: orderRef,
        payload: { order: { id: orderRef }, occurred_at: new Date().toISOString() }
      });
      await sendText(phone, "Recebi sua resposta para o pedido " + orderRef + ". Estou atualizando o painel.", { replyTo: messageId });
      return json(response, 200, { ok: true, processed: true, warnings: result.warnings });
    }

    if (command && command[1].toUpperCase() === "ENCERRAR" && sender === fiscal) {
      const orderRef = command[2].trim();
      if (orderRef.length > 180) return json(response, 200, { ok: true, ignored: true });
      const candidateMessageId = payload.messageId || payload.zaapId;
      const messageId = typeof candidateMessageId === "string" && candidateMessageId.length <= 100
        ? candidateMessageId
        : crypto.randomUUID();
      const result = await dispatchEvent({
        event_id: "zapi-fiscal-close:" + messageId,
        event_type: "order.rejected",
        order_ref: orderRef,
        payload: { order: { id: orderRef }, customer_informed: true, notify_fiscal: false, occurred_at: new Date().toISOString() }
      });
      await sendText(phone, "Pedido " + orderRef + " encerrado no painel. O sistema não enviou mensagem ao cliente.", { replyTo: messageId });
      return json(response, 200, { ok: true, closed: true, warnings: result.warnings });
    }

    if (fiscal && sender === fiscal) {
      const baseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
      if (!baseUrl) return json(response, 503, { message: "Formulário público ainda não configurado." });
      const { createPublicFormToken } = require("../../../lib/public-form-token");
      const formToken = createPublicFormToken();
      const link = baseUrl + "/pedido.html#acesso=" + encodeURIComponent(formToken.access) + "&expira=" + formToken.expiresAt;
      await sendText(phone, "Use este formulário para registrar o pedido: " + link + "\n\nVocê pode incluir produtos da Padaria, do Açougue e dos Frios no mesmo pedido. Adicione cada produto e selecione o setor responsável; o pedido pode envolver um, dois ou os três setores.\n\nApós investigar um impedimento, avise o cliente diretamente. Se não for possível atender, envie ENCERRAR <número do pedido> para registrar o encerramento.", { replyTo: payload.messageId });
      return json(response, 200, { ok: true, form_link_sent: true });
    }

    if (sender === bakery) {
      await sendText(phone, "Para atualizar um pedido, responda CONFIRMAR <número> se puder produzir ou RECUSAR <número> para pedir análise à fiscal. O pedido continua pendente durante a análise.", { replyTo: payload.messageId });
    }
    return json(response, 200, { ok: true, ignored: true });
  } catch (error) {
    return fail(response, error, "Não foi possível processar a mensagem recebida da Z-API.");
  }
};

