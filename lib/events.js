"use strict";

const crypto = require("node:crypto");
const { normalizePhone } = require("./phones");
const { formatOrderItems } = require("./order-items");
const { groupProductionItems, leadProductionRouteKey, productionPhone, productionRouteLabel } = require("./production-routing");
const { audit, claimAutomationRun, getActiveSectors, getOrderByReference, getOrderItems, getOperationSettings, rpc, updateAutomationRun, upsertCustomer } = require("./supabase");
const { enqueueWhatsappNotification, publishPendingWhatsappOutbox, publishWhatsappOutboxIds } = require("./whatsapp-outbox");

const EVENT_TYPES = new Set([
  "order.created", "order.confirmed", "order.rejected", "order.cancelled",
  "production.started", "production.issue", "production.completed",
  "order.fulfilled", "survey.response"
]);
const NOTIFICATION_TAGS_ONCE_PER_ORDER = new Set([
  "order-created-customer", "order-created-bakery", "order-created-confectionery", "order-created-butcher", "order-created-cold_cuts", "order-created-rotisserie", "order-created-other",
  "order-confirmed-customer", "order-confirmed-fiscal", "production-sector-bakery", "production-sector-confectionery", "production-sector-butcher", "production-sector-cold_cuts", "production-sector-rotisserie", "production-sector-other",
  "production-started-customer", "production-ready-customer", "production-ready-fiscal",
  "order-rejected-customer", "order-rejected-fiscal", "order-cancelled-customer", "order-cancelled-fiscal"
]);
const OUTBOX_PERSISTENCE_REQUIRED_FOR = new Set([
  "order.review_requested", "order.rejected", "production.completed"
]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function firstRecord(value) {
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === "object" ? value : {};
}

function validDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
}

function storedTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] || 0) > 59) return "";
  return match[1] + ":" + match[2] + ":" + (match[3] || "00");
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw Object.assign(new Error("Evento inválido."), { statusCode: 400 });
  if (!EVENT_TYPES.has(event.event_type)) throw Object.assign(new Error("Tipo de evento não permitido."), { statusCode: 422 });
  if (typeof event.event_id !== "string" || !event.event_id.trim() || event.event_id.length > 180) {
    throw Object.assign(new Error("event_id é obrigatório."), { statusCode: 422 });
  }
  if (typeof event.order_ref !== "string" || !event.order_ref.trim() || event.order_ref.length > 180) {
    throw Object.assign(new Error("order_ref é obrigatório."), { statusCode: 422 });
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw Object.assign(new Error("payload precisa ser um objeto."), { statusCode: 422 });
  }
  if (event.event_type === "order.rejected" && event.payload.fiscal_review_complete !== true) {
    throw Object.assign(new Error("A Fiscal precisa concluir a análise antes de informar que não será possível produzir."), { statusCode: 422 });
  }

  if (event.event_type === "order.created") {
    const customer = event.payload.customer || {};
    const order = event.payload.order || {};
    const items = asArray(event.payload.items);
    const customerName = typeof customer.name === "string" ? customer.name.trim() : "";
    if (!customerName || customerName.length > 120) throw Object.assign(new Error("O nome do cliente precisa ter entre 1 e 120 caracteres."), { statusCode: 422 });
    const phone = normalizePhone(customer.phone_e164 || customer.phone);
    if (!phone) throw Object.assign(new Error("Informe um WhatsApp válido para o cliente."), { statusCode: 422 });
    if (!validDate(order.requested_date)) throw Object.assign(new Error("Informe uma data de retirada válida."), { statusCode: 422 });
    if (!validTime(order.requested_time)) throw Object.assign(new Error("Informe um horário de retirada válido."), { statusCode: 422 });
    const rawPickupLocation = order.pickup_location || order.delivery_address;
    const pickupLocation = typeof rawPickupLocation === "string" ? rawPickupLocation.trim() : "";
    if (!pickupLocation || pickupLocation.length > 250) throw Object.assign(new Error("O local de retirada precisa ter entre 1 e 250 caracteres."), { statusCode: 422 });
    if (!items.length || items.length > 50 || items.some(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const name = [item.name, item.product_name]
        .find(value => typeof value === "string" && value.trim())?.trim() || "";
      const quantity = Number(item.quantity);
      return !name || name.length > 160 || !Number.isFinite(quantity) || quantity <= 0 || quantity > 999 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.sector_id || ""));
    })) {
      throw Object.assign(new Error("Informe de 1 a 50 produtos, cada um com setor, nome de até 160 caracteres e quantidade válida."), { statusCode: 422 });
    }
    if ((order.notes != null && typeof order.notes !== "string") || String(order.notes || "").length > 1000) throw Object.assign(new Error("As observações podem ter até 1.000 caracteres."), { statusCode: 422 });
    customer.name = customerName;
    customer.phone_e164 = phone;
  }

  if (["production.started", "production.issue", "production.completed"].includes(event.event_type) && !String(event.payload.production?.sector || event.payload.sector || "").trim()) {
    throw Object.assign(new Error("Informe o setor da produção."), { statusCode: 422 });
  }
  if (["production.started", "production.issue", "production.completed"].includes(event.event_type) && String(event.payload.production?.sector || event.payload.sector || "").length > 120) {
    throw Object.assign(new Error("O nome do setor excede o limite permitido."), { statusCode: 422 });
  }
  const productionSectorId = event.payload.production?.sector_id;
  if (productionSectorId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(productionSectorId))) {
    throw Object.assign(new Error("O identificador do setor é inválido."), { statusCode: 422 });
  }
  if (event.event_type === "production.issue" && !String(event.payload.reason || event.payload.production?.reason || "").trim()) {
    throw Object.assign(new Error("Descreva o problema de produção."), { statusCode: 422 });
  }
  if (["production.issue", "order.rejected"].includes(event.event_type) && String(event.payload.reason || event.payload.production?.reason || "").length > 500) {
    throw Object.assign(new Error("O motivo pode ter até 500 caracteres."), { statusCode: 422 });
  }
  if (event.event_type === "survey.response") {
    const survey = event.payload.survey || {};
    if (!Number.isInteger(Number(survey.rating)) || Number(survey.rating) < 1 || Number(survey.rating) > 5) {
      throw Object.assign(new Error("A avaliação precisa ser uma nota de 1 a 5."), { statusCode: 422 });
    }
    if (String(survey.comment || "").length > 1000) throw Object.assign(new Error("O comentário pode ter até 1.000 caracteres."), { statusCode: 422 });
  }
  return event;
}

function orderItems(order, fallbackItems = []) {
  const items = asArray(order?.items);
  const legacyItems = asArray(order?.order_items);
  return items.length ? items : legacyItems.length ? legacyItems : asArray(fallbackItems);
}

function pickupLabel(order) {
  const rawDate = String(order.requested_date || order.pickup_date || "");
  const match = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  const date = match ? match[3] + "/" + match[2] + "/" + match[1] : rawDate;
  const time = order.requested_time || order.pickup_time;
  return [date, time].filter(Boolean).join(" às ");
}

function testNote(order, fallbackNotes = "") {
  const notes = String(order.notes || order.order_notes || fallbackNotes || "").trim();
  return notes ? "\n\nObservações do pedido: " + notes : "";
}

async function notify(phone, message, tag, orderId, eventType, warnings, eventId, orderRef) {
  if (!phone) {
    warnings.push({ channel: "whatsapp", tag, message: "O número de destino não está cadastrado nas configurações do painel." });
    return;
  }
  const stableEventId = String(eventId || crypto.randomUUID());
  const identity = NOTIFICATION_TAGS_ONCE_PER_ORDER.has(tag)
    ? String(orderRef || stableEventId)
    : stableEventId;
  const jobKey = "event-notification:" + tag + ":" + identity;
  try {
    const queued = await enqueueWhatsappNotification({
      event_id: stableEventId,
      event_type: eventType || "zapi.command_reply",
      order_ref: orderRef || "",
      dedupe_key: jobKey,
      phone,
      message,
      tag
    });
    for (const warning of queued.warnings) {
      warnings.push({ channel: "whatsapp-queue", tag, message: "A mensagem ficou salva para nova tentativa, mas não foi publicada na fila: " + warning.message });
    }
  } catch (error) {
    warnings.push({ channel: "whatsapp-outbox", tag, message: "O pedido foi processado, mas não consegui registrar a mensagem para envio. A operação precisa revisar a conexão com o banco." });
    console.error("Falha ao registrar notificação na caixa de saída (" + tag + "): " + error.message);
    if (OUTBOX_PERSISTENCE_REQUIRED_FOR.has(eventType)) {
      throw Object.assign(new Error("Não foi possível gravar a notificação pendente no Supabase. A resposta não foi finalizada; tente novamente."), {
        statusCode: 503,
        cause: error
      });
    }
  }
}

async function sendEventNotification(phone, message, options) {
  const warnings = [];
  await notify(
    phone,
    message,
    options.tag,
    options.orderId || null,
    options.eventType || "zapi.command_reply",
    warnings,
    options.eventId,
    options.orderRef || ""
  );
  return warnings;
}

async function loadOrder(reference, event) {
  let order;
  try {
    order = await getOrderByReference(reference) || {};
  } catch (error) {
    console.error("Falha ao carregar pedido para notificações: " + error.message);
    order = event.payload?.order || {};
  }

  if (orderItems(order).length || !order.id) return order;
  try {
    const items = await getOrderItems(order.id);
    return items?.length ? { ...order, items } : order;
  } catch (error) {
    console.error("Falha ao carregar itens do pedido: " + error.message);
    return order;
  }
}

function buildProductionAgendaRows(order) {
  const orderId = order.id;
  const items = orderItems(order);
  if (!orderId) throw new Error("Não foi possível localizar o pedido para registrar a agenda.");
  if (!items.length) throw new Error("Os itens do pedido não foram carregados para registrar a agenda.");
  const orderReference = order.external_order_id || order.id;
  const requestedTime = storedTime(order.requested_time);
  const pickupDueAt = order.due_at || (() => {
    if (!validDate(order.requested_date) || !requestedTime) return null;
    return new Date(order.requested_date + "T" + requestedTime + "-03:00").toISOString();
  })();
  const groups = new Map();
  const plannedStartAt = new Date().toISOString();
  for (const item of items) {
    const key = item.sector_id || "default";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const agendaRows = [];
  for (const [, sectorItems] of groups) {
    const sectorId = sectorItems[0]?.sector_id || null;
    const sectorRow = firstRecord(sectorItems[0]?.sector);
    const sectorName = sectorRow.name || sectorItems[0]?.sector_name || "Produção";
    const sectorItemsForAgenda = sectorItems.map(item => {
      const product = firstRecord(item.product);
      const name = [item.name, item.product_name, product.name]
        .find(value => typeof value === "string" && value.trim()) || "Produto";
      return {
        ...item,
        name,
        product_name: item.product_name || name,
        quantity: item.quantity ?? 1,
        sector_id: item.sector_id || sectorId
      };
    });
    agendaRows.push({
      p_order_ref: String(orderReference),
      p_sector: {
        id: sectorId,
        sector_id: sectorId,
        name: sectorName,
        slug: sectorRow.slug || "",
        items: sectorItemsForAgenda
      },
      p_planned_start_at: plannedStartAt,
      p_due_at: pickupDueAt
    });
  }
  return agendaRows;
}

async function orderReady(orderId) {
  const result = await rpc("dashboard_order_readiness", { p_order_id: orderId });
  if (typeof result === "boolean") return result;
  const row = firstRecord(result);
  const ready = row.all_ready ?? row.ready ?? row.is_ready ?? row.every_sector_complete ?? row.all_completed ?? row.ready_for_pickup;
  return Boolean(ready);
}

async function startSatisfactionWorkflow(orderRef) {
  const { start } = await import("workflow/api");
  const { satisfactionSurvey } = await import("../workflows/satisfaction.js");
  const run = await start(satisfactionSurvey, [orderRef]);
  return run.runId;
}

function notificationDraft(event, phone, message, tag, orderRef = event.order_ref || "") {
  const stableEventId = String(event.event_id || crypto.randomUUID());
  const identity = NOTIFICATION_TAGS_ONCE_PER_ORDER.has(tag)
    ? String(orderRef || stableEventId)
    : stableEventId;
  return {
    dedupe_key: "event-notification:" + tag + ":" + identity,
    phone: normalizePhone(phone),
    message,
    tag
  };
}

function buildOrderCreatedNotifications(event, settings, activeSectors) {
  const payload = event.payload || {};
  const orderPayload = payload.order || {};
  const customer = payload.customer || {};
  const customerName = String(customer.name || "cliente");
  const customerPhone = normalizePhone(customer.phone_e164 || customer.phone);
  const dateTime = pickupLabel(orderPayload);
  const items = asArray(payload.items);
  const itemText = formatOrderItems(items);
  const note = testNote(orderPayload);
  const routes = groupProductionItems(items, activeSectors || []);
  const routeKey = leadProductionRouteKey(routes);
  const route = routes.get(routeKey);
  const sectorName = productionRouteLabel(route);
  const productionItems = formatOrderItems(route?.items || []) || itemText;
  const productionPhoneNumber = productionPhone(settings, routeKey);
  const orderRef = "{{order_ref}}";
  const productionRequest = [
    "NOVO PEDIDO · " + orderRef,
    "Setor responsável pela confirmação: " + sectorName,
    "Cliente: " + customerName,
    "WhatsApp: " + customerPhone,
    "Retirada: " + dateTime,
    "",
    "ITENS:",
    productionItems,
    "",
    note.trim(),
    "",
    "CONFIRMAÇÃO DA PRODUÇÃO",
    "Você consegue produzir os itens deste setor?",
    "1 — Confirmar",
    "2 — Informar que não consegue produzir",
    "Se houver apenas um pedido aguardando, responda somente 1 ou 2.",
    "Se houver mais de um, responda 1 ou 2 seguido do código exibido no topo desta mensagem."
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return [
    notificationDraft(event, customerPhone,
      "Olá, " + customerName + "! Recebemos seu pedido.\nRetirada: " + dateTime + ".\n\n" + itemText + "\n\nA equipe de produção vai confirmar a disponibilidade por aqui." + note,
      "order-created-customer", orderRef),
    notificationDraft(event, productionPhoneNumber, productionRequest,
      "order-created-" + routeKey, orderRef)
  ].filter(draft => draft.phone);
}

function buildOrderConfirmedNotifications(event, order, settings, activeSectors, warnings) {
  const payload = event.payload || {};
  const reference = event.order_ref || order.external_order_id || order.display_id || order.id;
  const customerPhone = normalizePhone(order.customer_phone || order.customer?.phone_e164 || payload.customer?.phone_e164 || payload.customer?.phone);
  const customerName = order.customer_name || order.customer?.name || payload.customer?.name || "cliente";
  const dateTime = pickupLabel({ ...order, ...(payload.order || {}) });
  const items = orderItems(order, payload.items);
  const itemText = formatOrderItems(items);
  const notes = testNote(order, payload.order?.notes);
  const routes = groupProductionItems(items, activeSectors || []);
  const confirmedRouteKey = String(payload.confirmed_route_key || leadProductionRouteKey(routes));
  const confirmedBy = String(payload.confirmed_by_sector || productionRouteLabel(routes.get(confirmedRouteKey)) || "Equipe de produção").slice(0, 160);
  const drafts = [];
  const push = (phone, message, tag) => {
    if (!phone) {
      warnings.push({ channel: "whatsapp", tag, message: "O número de destino não está cadastrado nas configurações do painel." });
      return;
    }
    drafts.push(notificationDraft(event, phone, message, tag, event.order_ref));
  };

  push(customerPhone,
    "Seu pedido foi confirmado para retirada " + dateTime + "." + notes,
    "order-confirmed-customer");
  push(settings.fiscal_phone_e164,
    "PEDIDO " + reference + "\nCONFIRMADO PELO SETOR: " + confirmedBy + "\nCliente: " + customerName + "\nRetirada: " + dateTime + "\n\nItens:\n" + itemText + notes,
    "order-confirmed-fiscal");

  for (const [routeKey, route] of routes) {
    if (routeKey === confirmedRouteKey) continue;
    const label = productionRouteLabel(route);
    const tag = "production-sector-" + routeKey;
    const phone = productionPhone(settings, routeKey);
    if (!phone) {
      warnings.push({ channel: "whatsapp", tag, message: "Cadastre o WhatsApp de " + label + " nas configurações para receber os itens deste setor." });
      continue;
    }
    const message = "PEDIDO " + reference + "\nPRODUÇÃO CONFIRMADA · " + label.toLocaleUpperCase("pt-BR") + "\nRetirada: " + dateTime + "\n\nITENS DESTE SETOR:\n" + formatOrderItems(route.items) + "\n\nSe este setor não conseguir produzir seus itens, responda somente 2. A Fiscal investigará alternativas antes de avisar o cliente." + notes;
    push(phone, message, tag);
  }
  return drafts;
}

function buildOtherEventNotifications(event, order, settings, warnings) {
  const payload = event.payload || {};
  const reference = event.order_ref || order.external_order_id || order.display_id || order.id;
  const customerName = order.customer_name || order.customer?.name || payload.customer?.name || "cliente";
  const customerPhone = normalizePhone(order.customer_phone || order.customer?.phone_e164 || payload.customer?.phone_e164 || payload.customer?.phone);
  const dateTime = pickupLabel({ ...order, ...(payload.order || {}) });
  const notes = testNote(order, payload.order?.notes);
  const drafts = [];
  const push = (phone, message, tag) => {
    if (!phone) {
      warnings.push({ channel: "whatsapp", tag, message: "O número de destino não está cadastrado nas configurações do painel." });
      return;
    }
    drafts.push(notificationDraft(event, phone, message, tag, event.order_ref));
  };

  switch (event.event_type) {
    case "order.rejected":
      push(customerPhone,
        "Olá, " + customerName + ". A Fiscal verificou as possibilidades e confirmou que não será possível produzir sua encomenda para " + dateTime + ".\n\nA Fiscal entrará em contato com você para conversar sobre o pedido.",
        "order-rejected-customer");
      if (payload.notify_fiscal !== false) {
        push(settings.fiscal_phone_e164,
          "O pedido " + reference + " foi encerrado no painel após a operação registrar a decisão." + (payload.reason ? " Motivo: " + payload.reason : ""),
          "order-rejected-fiscal");
      }
      break;
    case "order.cancelled":
      push(customerPhone,
        "Olá, " + customerName + ". Sua encomenda foi cancelada e não será preparada.\nRetirada prevista: " + dateTime + ".\n\nLamentamos o transtorno.",
        "order-cancelled-customer");
      push(settings.fiscal_phone_e164, "O pedido " + reference + " foi cancelado.", "order-cancelled-fiscal");
      break;
    case "production.started":
      if (payload.production?.notify_customer !== false) {
        push(customerPhone, "A produção do seu pedido começou. Avisaremos quando estiver pronto." + notes, "production-started-customer");
      }
      break;
    case "production.issue":
      push(settings.fiscal_phone_e164,
        "Atenção no pedido " + reference + ", setor " + (payload.production?.sector || payload.sector || "não informado") + ": " + (payload.reason || payload.production?.reason || ""),
        "production-issue-fiscal");
      break;
  }
  return drafts;
}

async function notifyForEvent(event, order, settings, warnings, options = {}) {
  if (["order.created", "order.confirmed", "order.rejected", "order.cancelled", "production.started", "production.issue"].includes(event.event_type)) return;
  const payload = event.payload || {};
  const orderPayload = payload.order || {};
  const customerPayload = payload.customer || {};
  const orderId = order.id || null;
  const reference = event.order_ref || order.external_order_id || order.display_id;
  const customerPhone = normalizePhone(order.customer_phone || order.customer?.phone_e164 || customerPayload.phone_e164 || customerPayload.phone);
  const dateTime = pickupLabel({ ...order, ...orderPayload });
  const submittedItems = asArray(payload.items);
  const itemText = formatOrderItems(
    event.event_type === "order.created" && submittedItems.length
      ? submittedItems
      : orderItems(order, submittedItems)
  );
  const customerName = order.customer_name || order.customer?.name || customerPayload.name || "cliente";

  switch (event.event_type) {
    case "order.created":
    case "order.confirmed":
      break;
    case "order.rejected": {
      await notify(
        customerPhone,
        "Olá, " + customerName + ". A Fiscal verificou as possibilidades e confirmou que não será possível produzir sua encomenda para " + dateTime + ".\n\nA Fiscal entrará em contato com você para conversar sobre o pedido.",
        "order-rejected-customer",
        orderId,
        event.event_type,
        warnings,
        event.event_id,
        event.order_ref
      );
      if (payload.notify_fiscal !== false) {
        await notify(settings.fiscal_phone_e164, "O pedido " + reference + " foi encerrado no painel após a operação registrar a decisão." + (payload.reason ? " Motivo: " + payload.reason : ""), "order-rejected-fiscal", orderId, event.event_type, warnings, event.event_id, event.order_ref);
      }
      break;
    }
    case "order.cancelled":
      await notify(
        customerPhone,
        "Olá, " + customerName + ". Sua encomenda foi cancelada e não será preparada.\nRetirada prevista: " + dateTime + ".\n\nLamentamos o transtorno.",
        "order-cancelled-customer",
        orderId,
        event.event_type,
        warnings,
        event.event_id,
        event.order_ref
      );
      await notify(settings.fiscal_phone_e164, "O pedido " + reference + " foi cancelado.", "order-cancelled-fiscal", orderId, event.event_type, warnings, event.event_id, event.order_ref);
      break;
    case "production.started":
      if (payload.production?.notify_customer !== false) {
        await notify(customerPhone, "A produção do seu pedido começou. Avisaremos quando estiver pronto." + testNote(order, payload.order?.notes), "production-started-customer", orderId, event.event_type, warnings, event.event_id, event.order_ref);
      }
      break;
    case "production.issue":
      await notify(settings.fiscal_phone_e164, "Atenção no pedido " + reference + ", setor " + (payload.production?.sector || payload.sector || "não informado") + ": " + (payload.reason || payload.production?.reason || ""), "production-issue-fiscal", orderId, event.event_type, warnings, event.event_id, event.order_ref);
      break;
    case "production.completed":
      if (orderId && await orderReady(orderId)) {
        await notify(customerPhone, "Seu pedido está pronto para retirada!" + testNote(order, payload.order?.notes), "production-ready-customer", orderId, event.event_type, warnings, event.event_id, event.order_ref);
        await notify(settings.fiscal_phone_e164, "Pedido " + reference + " pronto para retirada." + testNote(order, payload.order?.notes), "production-ready-fiscal", orderId, event.event_type, warnings, event.event_id, event.order_ref);
      }
      break;
    case "order.fulfilled":
      {
      const jobKey = "survey:" + event.order_ref;
      try {
        const claimed = await claimAutomationRun(jobKey, "satisfaction_survey", event.order_ref);
        if (!claimed) break;
        const startWorkflow = options.startSatisfactionWorkflow || startSatisfactionWorkflow;
        const runId = await startWorkflow(event.order_ref);
        await updateAutomationRun(jobKey, "scheduled", { run_id: runId });
        try { await audit({ order_id: orderId, event_type: event.event_type, action: "survey_scheduled", details: { run_id: runId }, occurred_at: new Date().toISOString() }); }
        catch { /* Workflow already started. */ }
      } catch (error) {
        try { await updateAutomationRun(jobKey, "failed", { reason: error.message }); } catch { /* The event remains recorded. */ }
        warnings.push({ channel: "workflow", tag: "satisfaction-survey", message: "Não foi possível agendar a pesquisa de satisfação." });
        console.error("Falha ao agendar pesquisa para " + reference + ": " + error.message);
      }
      break;
      }
    case "survey.response":
      break;
  }
}

async function requestFiscalReview(orderRef, reason = "", eventId = crypto.randomUUID(), sectorLabel = "Setor de produção", source = "dashboard") {
  const order = await getOrderByReference(String(orderRef || "").trim());
  if (!order) throw Object.assign(new Error("Pedido não encontrado para revisão."), { statusCode: 404 });
  const settings = await getOperationSettings();
  const reference = order.display_id || order.external_order_id || order.id || orderRef;
  const customerName = order.customer_name || order.customer?.name || "cliente";
  const dateTime = pickupLabel(order);
  const itemText = formatOrderItems(orderItems(order));
  const warnings = [];
  const reviewSource = source === "production_whatsapp" ? source : "dashboard";
  try {
    await audit({ order_id: order.id || null, event_type: "order.review_requested", action: "fiscal_review_requested", details: { order_ref: reference, reason: String(reason || "").slice(0, 500), source: reviewSource }, occurred_at: new Date().toISOString() });
  } catch (error) {
    console.error("Falha ao registrar a análise do pedido: " + error.message);
    if (reviewSource === "production_whatsapp") {
      throw Object.assign(new Error("A recusa chegou, mas não foi possível registrá-la no histórico. Tente novamente ou avise a operação."), { statusCode: 502, cause: error });
    }
  }
  if (!settings.fiscal_phone_e164) {
    warnings.push({ channel: "whatsapp", tag: "fiscal-review", message: "Cadastre o WhatsApp da fiscal para receber pedidos em revisão." });
  } else {
    await notify(settings.fiscal_phone_e164,
      [
        "PEDIDO RECUSADO · AGUARDANDO ANÁLISE DA FISCAL",
        "Pedido interno: " + reference,
        "Setor(es): " + String(sectorLabel || "Setor de produção").slice(0, 160),
        "Cliente: " + customerName,
        "Retirada: " + dateTime,
        "",
        "ITENS:",
        itemText,
        reason ? "Motivo informado: " + String(reason).slice(0, 500) : "",
        "",
        "Investigue com o setor se é possível viabilizar a produção ou uma alternativa.",
        "Se encontrar uma alternativa viável, combine com o setor e atualize o pedido no painel. Se concluir que não será possível, responda ENCERRAR " + reference + ". O sistema avisará o cliente; depois, entre em contato com ele."
      ].filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
      "order-review-fiscal", order.id || null, "order.review_requested", warnings, eventId, String(orderRef || reference));
  }
  return { ok: true, review_required: true, warnings };
}

async function dispatchEvent(input, options = {}) {
  const event = validateEvent(input);
  let result;
  let order = null;
  let activeSectors = [];
  let settings = options.settings;
  const warnings = [];
  try {
    const recovery = await publishPendingWhatsappOutbox();
    for (const warning of recovery.warnings) {
      warnings.push({ channel: "whatsapp-queue", message: "Há uma mensagem salva aguardando publicação na fila: " + warning.message });
    }
  } catch (error) {
    warnings.push({ channel: "whatsapp-outbox", message: "Não foi possível verificar notificações pendentes antes de processar o evento." });
    console.error("Falha ao recuperar notificações pendentes: " + error.message);
  }

  if (event.event_type === "order.created") {
    activeSectors = await getActiveSectors();
    const activeSectorIds = new Set((activeSectors || []).map(sector => String(sector.id)));
    if (asArray(event.payload.items).some(item => !activeSectorIds.has(String(item.sector_id)))) {
      throw Object.assign(new Error("Um ou mais produtos estão atribuídos a um setor inativo ou inexistente."), { statusCode: 422 });
    }
    settings = settings || await getOperationSettings();
    const routes = groupProductionItems(event.payload.items, activeSectors);
    const confirmationRouteKey = leadProductionRouteKey(routes);
    if (!productionPhone(settings, confirmationRouteKey)) {
      const sector = productionRouteLabel(routes.get(confirmationRouteKey));
      throw Object.assign(new Error("Cadastre o WhatsApp de " + sector + " em Configurações antes de registrar pedidos desse setor."), { statusCode: 503 });
    }
    const customer = event.payload.customer;
    await upsertCustomer(customer.name.trim(), customer.phone_e164);

    let createdOrder;
    try {
      const notifications = buildOrderCreatedNotifications(event, settings, activeSectors);
      createdOrder = firstRecord(await rpc("dashboard_create_order_with_code_and_outbox", {
        p_event_id: event.event_id,
        p_payload: event.payload,
        p_notifications: notifications
      }));
    } catch (error) {
      if (["PGRST202", "42883"].includes(error?.supabaseCode)) {
        throw Object.assign(new Error("O banco ainda não está preparado para registrar pedido e notificações juntos. Aplique a migração 20261022103016_atomic_order_event_and_agenda.sql no Supabase e tente novamente."), { statusCode: 503 });
      }
      throw error;
    }
    if (typeof createdOrder.order_ref !== "string" || !/^ENC \d{4}\.\d{3}\.\d{3,}$/.test(createdOrder.order_ref)) {
      throw Object.assign(new Error("O banco não retornou um código de encomenda válido."), { statusCode: 502 });
    }
    event.order_ref = createdOrder.order_ref;
    event.payload.order = { ...event.payload.order, id: event.order_ref };
    result = createdOrder.result;
    order = await loadOrder(event.order_ref, event) || {};
    const queueWarnings = await publishWhatsappOutboxIds(createdOrder.outbox_ids);
    for (const warning of queueWarnings) {
      warnings.push({ channel: "whatsapp-queue", message: "O pedido foi salvo, mas uma mensagem ficou pendente para publicação na fila: " + warning.message });
    }
  } else {
    let agendaRows = [];
    let notifications = [];
    if (event.event_type === "order.confirmed") {
      settings = settings || await getOperationSettings();
      [order, activeSectors] = await Promise.all([
        loadOrder(event.order_ref, event),
        getActiveSectors()
      ]);
      order = order || {};
      try { agendaRows = buildProductionAgendaRows(order); }
      catch (error) {
        throw Object.assign(new Error("A confirmação não foi registrada porque os itens não puderam ser preparados para a agenda."), { statusCode: 422, cause: error });
      }
      notifications = buildOrderConfirmedNotifications(event, order, settings, activeSectors, warnings);
    } else if (["order.rejected", "order.cancelled", "production.started", "production.issue"].includes(event.event_type)) {
      settings = settings || await getOperationSettings();
      order = await loadOrder(event.order_ref, event) || {};
      notifications = buildOtherEventNotifications(event, order, settings, warnings);
    }

    try {
      const transaction = firstRecord(await rpc("dashboard_process_event_with_outbox", {
        p_event_id: event.event_id,
        p_event_type: event.event_type,
        p_order_ref: event.order_ref,
        p_payload: event.payload,
        p_agenda_rows: agendaRows,
        p_notifications: notifications
      }));
      if (transaction.ok === false || transaction.success === false || transaction.error) {
        throw Object.assign(new Error("O evento não foi aceito pelas regras operacionais."), { statusCode: 422 });
      }
      result = transaction.result;
      const queueWarnings = await publishWhatsappOutboxIds(transaction.outbox_ids);
      for (const warning of queueWarnings) {
        warnings.push({ channel: "whatsapp-queue", message: "A alteração foi salva, mas uma mensagem ficou pendente para publicação na fila: " + warning.message });
      }
    } catch (error) {
      if (["PGRST202", "42883"].includes(error?.supabaseCode)) {
        throw Object.assign(new Error("O banco ainda não está preparado para salvar a atualização, a agenda e as notificações na mesma transação. Aplique a migração 20261022103016_atomic_order_event_and_agenda.sql no Supabase e tente novamente."), { statusCode: 503 });
      }
      throw error;
    }
  }
  const resultRow = firstRecord(result);
  if (resultRow.ok === false || resultRow.success === false || resultRow.error) {
    throw Object.assign(new Error("O evento não foi aceito pelas regras operacionais."), { statusCode: 422 });
  }

  settings = settings || await getOperationSettings();
  order = order || await loadOrder(event.order_ref, event) || {};
  await notifyForEvent(event, order, settings, warnings, { ...options, activeSectors });
  try {
    await audit({
      order_id: order.id || null,
      event_type: event.event_type,
      action: "event_processed_by_dashboard_api",
      details: { event_id: event.event_id, order_ref: event.order_ref },
      occurred_at: new Date().toISOString()
    });
  } catch (error) {
    console.error("Falha ao gravar auditoria do evento: " + error.message);
  }
  return { ok: true, order_ref: event.order_ref, result, warnings };
}

function actionEvent(body) {
  const eventTypes = {
    accept: "order.confirmed",
    reject: "order.rejected",
    start_preparing: "production.started",
    mark_ready: "production.completed",
    report_issue: "production.issue",
    fulfill: "order.fulfilled"
  };
  const eventType = eventTypes[body.action];
  if (!eventType) throw Object.assign(new Error("Ação de pedido desconhecida."), { statusCode: 422 });
  const orderRef = String(body.external_order_id || body.order_ref || "");
  return {
    event_id: String(body.event_id || crypto.randomUUID()),
    event_type: eventType,
    order_ref: orderRef,
    payload: {
      order: { id: orderRef },
      ...(body.customer_phone ? { customer: { phone_e164: normalizePhone(body.customer_phone) } } : {}),
      ...(body.sector || body.sector_id ? { production: {
        ...(body.sector ? { sector: String(body.sector) } : {}),
        ...(body.sector_id ? { sector_id: String(body.sector_id) } : {}),
        ...(body.notify_customer === false ? { notify_customer: false } : {})
      } } : {}),
      ...(body.fiscal_review_complete === true ? { fiscal_review_complete: true } : {}),
      ...(body.customer_informed === true ? { customer_informed: true } : {}),
      ...(body.reason ? { reason: String(body.reason).trim() } : {}),
      occurred_at: new Date().toISOString()
    }
  };
}

function createOrderEvent(body) {
  const payload = body?.payload || body;
  const order = payload.order || {};
  const customer = payload.customer || {};
  const fiscal = payload.fiscal || {};
  const items = asArray(payload.items).map(value => {
    const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      name: [item.name, item.product_name]
        .find(value => typeof value === "string" && value.trim())?.trim() || "",
      quantity: Number(item.quantity),
      ...((typeof (item.product_id || item.id) === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.product_id || item.id)))
        ? { product_id: String(item.product_id || item.id) }
        : {}),
      ...((typeof (item.product_size_id || item.size_id) === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(item.product_size_id || item.size_id)))
        ? { product_size_id: String(item.product_size_id || item.size_id) }
        : {}),
      ...((typeof (item.size_label || item.size) === "string" && String(item.size_label || item.size).trim())
        ? { size_label: String(item.size_label || item.size).trim().slice(0, 100) }
        : {}),
      ...(item.sector_id ? { sector_id: item.sector_id } : {}),
      ...(typeof item.sector === "string" ? { sector: item.sector.slice(0, 120) } : {})
    };
  });
  const orderRef = String(body.order_ref || order.id || "PENDING-" + crypto.randomUUID().toUpperCase());
  return {
    event_id: String(body.event_id || crypto.randomUUID()),
    event_type: "order.created",
    order_ref: orderRef,
    payload: {
      order: {
        id: orderRef,
        requested_date: String(order.requested_date || order.pickup_date || ""),
        requested_time: String(order.requested_time || order.pickup_time || ""),
        pickup_location: typeof (order.pickup_location || order.delivery_address) === "string" ? String(order.pickup_location || order.delivery_address).trim() : "",
        fulfillment_type: order.fulfillment_type || "pickup",
        notes: typeof order.notes === "string" ? order.notes.trim() : ""
      },
      customer: {
        name: typeof customer.name === "string" ? customer.name.trim() : "",
        phone_e164: normalizePhone(customer.phone_e164 || customer.phone)
      },
      fiscal: { phone_e164: normalizePhone(fiscal.phone_e164 || fiscal.phone) },
      items
    }
  };
}

module.exports = { actionEvent, createOrderEvent, dispatchEvent, requestFiscalReview, sendEventNotification, validateEvent };

