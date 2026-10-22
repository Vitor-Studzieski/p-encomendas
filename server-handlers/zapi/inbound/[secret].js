"use strict";

const crypto = require("node:crypto");
const { dispatchEvent, requestFiscalReview, sendEventNotification } = require("../../../lib/events");
const { enforceRateLimit, fail, json, methodNotAllowed, readBody, sameSecret } = require("../../../lib/http");
const { normalizePhone } = require("../../../lib/phones");
const { groupProductionItems, leadProductionRouteKey, productionRouteLabel } = require("../../../lib/production-routing");
const { claimAutomationRun, getOperationSettings, getOpenProductionOrders, getOrderByReference, getProductionRefusalOrderIds, updateAutomationRun } = require("../../../lib/supabase");

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

function ordersAnswerableBySender(orders, routeKeys, decision) {
  return orders.filter(order => {
    if (order.production_refused) return false;
    const pending = ["awaiting_confirmation", "pending"].includes(String(order.status || "").toLowerCase());
    const leadRouteKey = leadProductionRouteKey(order.items);
    if (decision === "CONFIRMAR") return pending && routeKeys.includes(leadRouteKey);
    if (pending) return routeKeys.includes(leadRouteKey);
    return matchingOrderSectors(order, routeKeys).length > 0;
  });
}

function productionOrderCodes(orders, limit = 5) {
  const uniqueCodes = [...new Set(orders
    .map(order => String(order.display_id || "").trim())
    .filter(Boolean))];
  const shown = uniqueCodes.slice(0, limit);
  if (uniqueCodes.length > limit) shown.push("e mais " + (uniqueCodes.length - limit));
  return shown;
}

function unknownOrderReply(reference, matchingOrders, routes) {
  const sectors = [...new Set(matchingOrders.map(order => productionReplyLabel(order, routes)).filter(Boolean))];
  const sectorText = sectors.length ? sectors.join(", ") : "seu setor";
  const codes = productionOrderCodes(matchingOrders);
  const lines = [
    "Não localizei o pedido \"" + String(reference).slice(0, 180) + "\". Nenhuma resposta foi registrada.",
    "Confira o código no topo da mensagem do pedido."
  ];
  if (codes.length) {
    lines.push("Pedidos disponíveis para resposta em " + sectorText + ": " + codes.join(", ") + ".");
    if (matchingOrders.length === 1) lines.push("Como há somente um pedido aguardando, você também pode responder apenas 1 ou 2.");
  } else {
    lines.push("Não há pedido ativo disponível para resposta deste setor.");
  }
  return lines.join("\n");
}

async function settleNumericReply(key, status, details) {
  if (!key) return;
  try { await updateAutomationRun(key, status, details); }
  catch (error) { console.error("Não foi possível finalizar a resposta numérica da produção: " + error.message); }
}

module.exports = async function zapiInbound(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  const expected = process.env.ZAPI_WEBHOOK_SECRET;
  if (!expected || !/^[A-Za-z0-9_-]{32,160}$/.test(expected)) {
    return json(response, 503, { message: "Configure um ZAPI_WEBHOOK_SECRET URL-safe com pelo menos 32 caracteres." });
  }
  if (!sameSecret(requestSecret(request), expected)) return json(response, 404, { message: "Não encontrado." });

  let numericReplyClaimKey = "";
  let numericReplyActionStarted = false;
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
        numericReplyClaimKey = "zapi-production-reply:" + messageId;
        const claimed = await claimAutomationRun(numericReplyClaimKey, "production_whatsapp_reply", phone);
        if (!claimed) {
          const replyWarnings = await sendEventNotification(phone, "Essa resposta já está sendo processada ou já foi registrada. Não vou aplicá-la a outro pedido.", {
            tag: "zapi-duplicate-reply-ack",
            eventId: "zapi-duplicate-ack:" + messageId
          });
          return json(response, 200, { ok: true, processed: false, duplicate: true, warnings: replyWarnings });
        }
      }
      if (orderRef.length > 180) {
        const replyWarnings = await sendEventNotification(phone, "O código informado é longo demais. Confira e envie novamente o código exibido no topo da mensagem do pedido.", {
          tag: "zapi-production-help",
          eventId: "zapi-ack:" + messageId
        });
        return json(response, 200, { ok: true, processed: false, reason: "order_reference_too_long", warnings: replyWarnings });
      }
      if (numericAnswer && !orderRef) {
        const openOrders = await getOpenProductionOrders();
        const refusedIds = await getProductionRefusalOrderIds(openOrders.map(order => order.id));
        const replyOrders = openOrders.map(order => ({ ...order, production_refused: refusedIds.has(String(order.id)) }));
        const matchingOrders = ordersAnswerableBySender(replyOrders, senderRouteKeys, decision);
        if (!matchingOrders.length) {
          const sectorText = [...new Set(senderRoutes.map(route => route.label))].join(", ") || "seu setor";
          const reply = decision === "CONFIRMAR"
            ? "Não há pedido novo aguardando confirmação para " + sectorText + ". Se você respondeu 2 a um pedido há pouco, ele continua pendente enquanto a Fiscal analisa."
            : "Não há outro pedido disponível para encaminhar à Fiscal por " + sectorText + ". Se você respondeu 2 há pouco, a Fiscal já recebeu o aviso e o pedido continua em análise.";
          const replyWarnings = await sendEventNotification(phone, reply, {
            tag: "zapi-production-help",
            eventId: "zapi-ack:" + messageId
          });
          await settleNumericReply(numericReplyClaimKey, "sent", { reason: "no_matching_sector_order" });
          numericReplyClaimKey = "";
          return json(response, 200, { ok: true, processed: false, reason: "no_matching_sector_order", warnings: replyWarnings });
        }
        // Mensagens numéricas são processadas em fila, da mais recente para a mais antiga.
        // O código do pedido é opcional e deixa de ser necessário quando há vários pedidos.
        selectedOrder = matchingOrders[0];
        orderRef = String(selectedOrder.display_id || selectedOrder.external_order_id || selectedOrder.id || "").trim();
        if (!orderRef) throw Object.assign(new Error("O pedido aguardando confirmação não tem código interno."), { statusCode: 409 });
      } else {
        selectedOrder = await getOrderByReference(orderRef);
        if (!selectedOrder) {
          const openOrders = await getOpenProductionOrders();
          const matchingOrders = ordersAnswerableBySender(openOrders, senderRouteKeys, decision);
          const replyWarnings = await sendEventNotification(phone, unknownOrderReply(orderRef, matchingOrders, senderRoutes), {
            tag: "zapi-production-help",
            eventId: "zapi-ack:" + messageId
          });
          return json(response, 200, {
            ok: true,
            processed: false,
            reason: "order_reference_not_found",
            available_order_refs: productionOrderCodes(matchingOrders),
            warnings: replyWarnings
          });
        }
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
        numericReplyActionStarted = Boolean(numericReplyClaimKey);
        const review = await requestFiscalReview(orderRef, "", "zapi-review:" + messageId, selectedOrder ? productionReplyLabel(selectedOrder, senderRoutes) : [...new Set(senderRoutes.map(route => route.label))].join(", "), "production_whatsapp");
        const selectedLabel = selectedOrder?.display_id || (selectedOrder?.customer_name ? "o pedido de " + selectedOrder.customer_name : "o pedido selecionado");
        const reply = review.warnings.length
          ? "Recusa registrada para " + selectedLabel + ". O pedido continua pendente, mas não consegui confirmar o aviso à Fiscal. Avise a operação diretamente."
          : "Recusa registrada para " + selectedLabel + ". A Fiscal foi avisada para investigar se é possível viabilizar a produção. O pedido continua pendente e o cliente só será avisado depois da análise final da Fiscal.";
        const replyWarnings = await sendEventNotification(phone, reply, {
          tag: "zapi-review-ack",
          eventId: "zapi-ack:" + messageId,
          orderRef
        });
        review.warnings.push(...replyWarnings);
        await settleNumericReply(numericReplyClaimKey, "sent", { order_ref: orderRef, decision: "review_requested" });
        numericReplyClaimKey = "";
        return json(response, 200, { ok: true, review_requested: true, warnings: review.warnings });
      }
      const confirmedRouteKey = leadProductionRouteKey(selectedOrder?.items);
      const confirmedRoute = groupProductionItems(selectedOrder?.items).get(confirmedRouteKey);
      numericReplyActionStarted = Boolean(numericReplyClaimKey);
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
      const selectedLabel = selectedOrder?.display_id || (selectedOrder?.customer_name ? "o pedido de " + selectedOrder.customer_name : "o pedido selecionado");
      const selectedSector = productionRouteLabel(confirmedRoute);
      const replyWarnings = await sendEventNotification(phone, "Confirmação registrada para " + selectedLabel + (selectedSector ? " (" + selectedSector + ")" : "") + ". O pedido foi marcado como confirmado no painel.", {
        tag: "zapi-confirmation-ack",
        eventId: "zapi-ack:" + messageId,
        orderRef
      });
      await settleNumericReply(numericReplyClaimKey, "sent", { order_ref: orderRef, decision: "confirmed" });
      numericReplyClaimKey = "";
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
      await sendEventNotification(phone, help + "\n\nQuando houver vários pedidos, 1 ou 2 será aplicado ao pedido mais recente ainda aguardando resposta do seu setor. A confirmação ou o encaminhamento à Fiscal informará qual pedido foi selecionado.", {
        tag: "zapi-production-help",
        eventId: "zapi-message:" + messageId
      });
    }
    return json(response, 200, { ok: true, ignored: true });
  } catch (error) {
    await settleNumericReply(numericReplyClaimKey, numericReplyActionStarted ? "sent" : "failed", { reason: error.message });
    return fail(response, error, "Não foi possível processar a mensagem recebida da Z-API.");
  }
};

