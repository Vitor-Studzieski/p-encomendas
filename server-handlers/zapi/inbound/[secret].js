"use strict";

const crypto = require("node:crypto");
const { dispatchEvent, requestFiscalReview, sendEventNotification } = require("../../../lib/events");
const { enforceRateLimit, fail, json, methodNotAllowed, readBody, sameSecret } = require("../../../lib/http");
const { normalizePhone } = require("../../../lib/phones");
const { groupProductionItems, leadProductionRouteKey, productionRouteLabel } = require("../../../lib/production-routing");
const { getOperationSettings, getOpenProductionOrders, getOrderByReference } = require("../../../lib/supabase");

function requestSecret(request) {
  if (request.query?.secret) return Array.isArray(request.query.secret) ? request.query.secret[0] : request.query.secret;
  const match = String(request.url || "").match(/^\/api\/zapi\/inbound\/([^/?]+)/);
  return match ? match[1] : "";
}

function inboundPhone(payload) {
  return normalizePhone(payload.phone || payload.chatId || payload.participantPhone);
}

function inboundMessageId(payload) {
  const candidate = payload.messageId || payload.zaapId;
  if (typeof candidate === "string" && candidate.trim() && candidate.length <= 100) return candidate;
  return "fallback-" + crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function configuredProductionRoutes(settings) {
  return [
    { phone: settings.bakery_phone_e164, key: "bakery", label: "Padaria" },
    { phone: settings.confectionery_phone_e164, key: "confectionery", label: "Confeitaria" },
    { phone: settings.butcher_phone_e164, key: "butcher", label: "Açougue" },
    { phone: settings.cold_cuts_phone_e164, key: "cold_cuts", label: "Frios" },
    { phone: settings.rotisserie_phone_e164, key: "rotisserie", label: "Rotisseria" }
  ].map(route => ({ ...route, phone: normalizePhone(route.phone).replace(/\D/g, "") })).filter(route => route.phone);
}

function matchingOrderSectors(order, routeKeys) {
  const routes = groupProductionItems(order?.items);
  return routeKeys.flatMap(routeKey => Array.from(routes.get(routeKey)?.sectorNames || []));
}

function productionReplyLabel(order, routes) {
  const groups = groupProductionItems(order?.items);
  const names = [...new Set(routes.flatMap(route => Array.from(groups.get(route.key)?.sectorNames || [])))];
  return names.length ? names.join(", ") : [...new Set(routes.map(route => route.label))].join(", ");
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
    const messageId = inboundMessageId(payload);

    const settings = await getOperationSettings();
    const sender = phone.replace(/\D/g, "");
    const fiscal = normalizePhone(settings.fiscal_phone_e164).replace(/\D/g, "");
    const productionRoutes = configuredProductionRoutes(settings);
    const senderRoutes = productionRoutes.filter(route => route.phone === sender);
    const senderRouteKeys = [...new Set(senderRoutes.map(route => route.key))];
    const isProductionSender = senderRoutes.length > 0;
    const command = text.match(/^\s*(CONFIRMAR|RECUSAR|ENCERRAR)\s+(.+?)\s*$/i);
    const numericAnswer = text.match(/^\s*([12])(?:\s+(.+?))?\s*$/);

    const commandDecision = command?.[1].toUpperCase();
    const isProductionDecision = isProductionSender && (
      numericAnswer || (command && ["CONFIRMAR", "RECUSAR"].includes(commandDecision))
    );

    if (isProductionDecision) {
      const decision = numericAnswer ? (numericAnswer[1] === "1" ? "CONFIRMAR" : "RECUSAR") : commandDecision;
      let orderRef = command ? command[2].trim() : String(numericAnswer?.[2] || "").trim();
      let selectedOrder = null;
      if (numericAnswer && !orderRef) {
        const openOrders = await getOpenProductionOrders();
        const matchingOrders = openOrders.filter(order => {
          const pending = ["awaiting_confirmation", "pending"].includes(String(order.status || "").toLowerCase());
          const leadRouteKey = leadProductionRouteKey(order.items);
          if (decision === "CONFIRMAR") return pending && senderRouteKeys.includes(leadRouteKey);
          if (pending) return senderRouteKeys.includes(leadRouteKey);
          return matchingOrderSectors(order, senderRouteKeys).length > 0;
        });
        if (matchingOrders.length !== 1) {
          const reply = matchingOrders.length
            ? "Há mais de um pedido ativo deste setor. Para a Padaria confirmar pelo WhatsApp sem risco de alterar o pedido errado, responda 1 seguido do código no topo da mensagem. Para informar que não consegue produzir, responda 2 seguido do código. Exemplo: 1 ENC 2026.001.001."
            : decision === "CONFIRMAR"
              ? "Não encontrei pedido aguardando confirmação inicial destinado a este setor. Confira se o código no topo da mensagem corresponde a um pedido aberto. Se necessário, peça à operação para verificar o status."
              : "Não encontrei um pedido ativo deste setor para vincular à resposta. Confira o código e o setor no topo da mensagem.";
          const replyWarnings = await sendEventNotification(phone, reply, {
            tag: "zapi-production-help",
            eventId: "zapi-ack:" + messageId
          });
          return json(response, 200, { ok: true, processed: false, reason: matchingOrders.length ? "ambiguous_sector_orders" : "no_matching_sector_order", warnings: replyWarnings });
        }
        selectedOrder = matchingOrders[0];
        orderRef = String(selectedOrder.display_id || "").trim();
        if (!orderRef) throw Object.assign(new Error("O pedido aguardando confirmação não tem código interno."), { statusCode: 409 });
      } else {
        selectedOrder = await getOrderByReference(orderRef);
        if (!selectedOrder) throw Object.assign(new Error("Pedido não encontrado para atualizar."), { statusCode: 404 });
        const pending = ["awaiting_confirmation", "pending"].includes(String(selectedOrder.status || "").toLowerCase());
        const leadRouteKey = leadProductionRouteKey(selectedOrder.items);
        const assignedToSender = matchingOrderSectors(selectedOrder, senderRouteKeys).length > 0;
        const canAnswerInitialConfirmation = pending && senderRouteKeys.includes(leadRouteKey);
        const invalidResponse = decision === "CONFIRMAR"
          ? !canAnswerInitialConfirmation
          : !assignedToSender || (pending && !canAnswerInitialConfirmation);
        if (invalidResponse) {
          const leadRoute = groupProductionItems(selectedOrder.items).get(leadRouteKey);
          const leadSector = productionRouteLabel(leadRoute);
          const reply = decision === "CONFIRMAR"
            ? "Não registrei a confirmação: este pedido não está aguardando uma resposta inicial deste setor."
            : !assignedToSender
              ? "Não registrei a resposta: este pedido não contém itens vinculados ao seu setor. Confira o código e o setor indicados no topo da mensagem."
              : "A confirmação inicial deste pedido está direcionada a " + leadSector + ". Só esse setor pode responder antes da confirmação.";
          const replyWarnings = await sendEventNotification(phone, reply, {
            tag: "zapi-production-help",
            eventId: "zapi-ack:" + messageId,
            orderRef
          });
          return json(response, 200, { ok: true, processed: false, reason: "order_not_assigned_to_confirmation", warnings: replyWarnings });
        }
      }
      if (orderRef.length > 180) return json(response, 200, { ok: true, ignored: true });
      if (decision === "RECUSAR") {
        const review = await requestFiscalReview(orderRef, "", "zapi-review:" + messageId, selectedOrder ? productionReplyLabel(selectedOrder, senderRoutes) : [...new Set(senderRoutes.map(route => route.label))].join(", "), "production_whatsapp");
        const reply = review.warnings.length
          ? "Recusa registrada. O pedido continua pendente, mas não consegui confirmar o aviso à Fiscal. Avise a operação diretamente."
          : "Recusa registrada. A Fiscal foi avisada para investigar se é possível viabilizar a produção. O cliente só será avisado depois da análise final da Fiscal.";
        const replyWarnings = await sendEventNotification(phone, reply, {
          tag: "zapi-review-ack",
          eventId: "zapi-ack:" + messageId,
          orderRef
        });
        review.warnings.push(...replyWarnings);
        return json(response, 200, { ok: true, review_requested: true, warnings: review.warnings });
      }
      const confirmedRouteKey = leadProductionRouteKey(selectedOrder?.items);
      const confirmedRoute = groupProductionItems(selectedOrder?.items).get(confirmedRouteKey);
      const result = await dispatchEvent({
        event_id: "zapi-reply:" + messageId,
        event_type: "order.confirmed",
        order_ref: orderRef,
        payload: {
          order: { id: orderRef },
          confirmed_route_key: confirmedRouteKey,
          confirmed_by_sector: productionRouteLabel(confirmedRoute),
          occurred_at: new Date().toISOString()
        }
      });
      const replyWarnings = await sendEventNotification(phone, "Confirmação registrada. O pedido foi marcado como confirmado no painel.", {
        tag: "zapi-confirmation-ack",
        eventId: "zapi-ack:" + messageId,
        orderRef
      });
      return json(response, 200, { ok: true, processed: true, warnings: [...result.warnings, ...replyWarnings] });
    }

    if (command && command[1].toUpperCase() === "ENCERRAR" && sender === fiscal) {
      const orderRef = command[2].trim();
      if (orderRef.length > 180) return json(response, 200, { ok: true, ignored: true });
      const result = await dispatchEvent({
        event_id: "zapi-fiscal-close:" + messageId,
        event_type: "order.rejected",
        order_ref: orderRef,
        payload: { order: { id: orderRef }, fiscal_review_complete: true, notify_fiscal: false, occurred_at: new Date().toISOString() }
      });
      const replyWarnings = await sendEventNotification(phone, "Análise final registrada. O cliente recebeu a mensagem automática. Entre em contato com ele para conversar sobre o pedido.", {
        tag: "zapi-close-ack",
        eventId: "zapi-ack:" + messageId,
        orderRef
      });
      return json(response, 200, { ok: true, closed: true, warnings: [...result.warnings, ...replyWarnings] });
    }

    if (fiscal && sender === fiscal) {
      const baseUrl = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "");
      if (!baseUrl) return json(response, 503, { message: "Formulário público ainda não configurado." });
      const { createPublicFormToken } = require("../../../lib/public-form-token");
      const formToken = createPublicFormToken();
      const link = baseUrl + "/pedido.html#acesso=" + encodeURIComponent(formToken.access) + "&expira=" + formToken.expiresAt;
      await sendEventNotification(phone, "Use este formulário para registrar o pedido: " + link + "\n\nInclua produtos dos setores Padaria, Confeitaria, Açougue, Frios e Rotisseria. Selecione o setor responsável para cada item; um pedido pode envolver vários setores.\n\nQuando qualquer setor informar que não consegue produzir um pedido, investigue primeiro se é possível viabilizar a produção. Se, após a análise, concluir que não será possível, responda ENCERRAR <código do pedido>. O cliente receberá uma mensagem e você deverá entrar em contato com ele.", {
        tag: "zapi-fiscal-form-link",
        eventId: "zapi-message:" + messageId
      });
      return json(response, 200, { ok: true, form_link_sent: true });
    }

    if (isProductionSender) {
      const help = "Quando seu setor receber a confirmação inicial do pedido, envie 1 para confirmar. Se não puder produzir seus itens, envie 2 para pedir análise da Fiscal. A recusa é encaminhada primeiro somente à Fiscal; o cliente só é avisado após a análise final.";
      await sendEventNotification(phone, help + "\n\nSe houver mais de um pedido compatível com seu setor, responda 1 seguido do código no topo para confirmar ou 2 seguido do código para pedir análise. Exemplo: 1 ENC 2026.001.001.", {
        tag: "zapi-production-help",
        eventId: "zapi-message:" + messageId
      });
    }
    return json(response, 200, { ok: true, ignored: true });
  } catch (error) {
    return fail(response, error, "Não foi possível processar a mensagem recebida da Z-API.");
  }
};

