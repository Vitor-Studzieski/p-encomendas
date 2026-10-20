"use strict";

const crypto = require("node:crypto");
const { normalizePhone } = require("./phones");
const { audit, claimAutomationRun, getActiveSectors, getOrderByReference, getOperationSettings, rpc, updateAutomationRun, upsertCustomer } = require("./supabase");
const { sendText } = require("./zapi");

const EVENT_TYPES = new Set([
  "order.created", "order.confirmed", "order.rejected", "order.cancelled",
  "production.started", "production.issue", "production.completed",
  "order.fulfilled", "survey.response"
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
  if (event.event_type === "order.rejected" && event.payload.customer_informed !== true) {
    throw Object.assign(new Error("A fiscal precisa confirmar que já avisou o cliente antes de encerrar o pedido."), { statusCode: 422 });
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
      const rawName = item.name || item.product_name;
      const name = typeof rawName === "string" ? rawName.trim() : "";
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

function formatItems(items) {
  return asArray(items).map(item => String(item.quantity || 1) + "× " + String(item.name || item.product_name || "Item")).join("\n");
}

function pickupLabel(order) {
  const date = order.requested_date || order.pickup_date;
  const time = order.requested_time || order.pickup_time;
  return [date, time].filter(Boolean).join(" às ");
}

function testNote(order, fallbackNotes = "") {
  const notes = String(order.notes || order.order_notes || fallbackNotes || "").trim();
  return notes ? "\n\nObservações do pedido: " + notes : "";
}

async function notify(phone, message, tag, orderId, eventType, warnings) {
  if (!phone) return;
  try {
    await sendText(phone, message);
    try {
      await audit({ order_id: orderId || null, event_type: eventType, action: "whatsapp_sent", details: { tag }, occurred_at: new Date().toISOString() });
    } catch { /* The order transition must not be undone by an audit outage. */ }
  } catch (error) {
    warnings.push({ channel: "whatsapp", tag, message: error.message });
    try {
      await audit({ order_id: orderId || null, event_type: eventType, action: "whatsapp_failed", details: { tag, reason: error.message }, occurred_at: new Date().toISOString() });
    } catch { /* Keep the original delivery error. */ }
    console.error("Falha no envio da Z-API (" + tag + "): " + error.message);
  }
}

async function loadOrder(reference, event) {
  try { return await getOrderByReference(reference); }
  catch (error) {
    console.error("Falha ao carregar pedido para notificações: " + error.message);
    return event.payload?.order || {};
  }
}

async function updateProductionAgenda(order) {
  const orderId = order.id;
  const items = order.items || order.order_items || [];
  if (!orderId || !items.length) return;
  const orderReference = order.external_order_id || order.id;
  const pickupDueAt = order.due_at || (() => {
    if (!validDate(order.requested_date) || !validTime(order.requested_time)) return null;
    return new Date(order.requested_date + "T" + order.requested_time + ":00-03:00").toISOString();
  })();
  const groups = new Map();
  for (const item of items) {
    const key = item.sector_id || "default";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const [, sectorItems] of groups) {
    const sectorId = sectorItems[0]?.sector_id || null;
    const sectorRow = firstRecord(sectorItems[0]?.sector);
    const sectorName = sectorRow.name || sectorItems[0]?.sector_name || "Produção";
    const sectorItemsForAgenda = sectorItems.map(item => {
      const product = firstRecord(item.product);
      const name = item.name || item.product_name || product.name || "Produto";
      return {
        ...item,
        name,
        product_name: item.product_name || name,
        quantity: item.quantity ?? 1,
        sector_id: item.sector_id || sectorId
      };
    });
    await rpc("dashboard_upsert_production_agenda", {
      p_order_ref: orderReference,
      p_sector: {
        id: sectorId,
        sector_id: sectorId,
        name: sectorName,
        slug: sectorRow.slug || "",
        items: sectorItemsForAgenda
      },
      p_planned_start_at: new Date().toISOString(),
      p_due_at: pickupDueAt
    });
  }
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

async function notifyForEvent(event, order, settings, warnings) {
  const payload = event.payload || {};
  const orderPayload = payload.order || {};
  const customerPayload = payload.customer || {};
  const orderId = order.id || null;
  const reference = order.display_id || order.external_order_id || event.order_ref;
  const customerPhone = normalizePhone(order.customer_phone || order.customer?.phone_e164 || customerPayload.phone_e164 || customerPayload.phone);
  const dateTime = pickupLabel({ ...order, ...orderPayload });
  const itemText = formatItems(order.items || order.order_items || payload.items || []);
  const customerName = order.customer_name || order.customer?.name || customerPayload.name || "cliente";

  switch (event.event_type) {
    case "order.created": {
      const note = testNote(order, orderPayload.notes);
      const receipt = "Olá, " + customerName + "! Recebemos o pedido " + reference + ".\nRetirada: " + dateTime + ".\n\n" + itemText + "\n\nA padaria vai confirmar a disponibilidade por aqui." + note;
      const bakery = "NOVO PEDIDO " + reference + "\nCliente: " + customerName + "\nWhatsApp: " + customerPhone + "\nRetirada: " + dateTime + "\n\n" + itemText + note;
      await notify(customerPhone, receipt, "order-created-customer", orderId, event.event_type, warnings);
      await notify(settings.bakery_phone_e164, bakery, "order-created-bakery", orderId, event.event_type, warnings);
      break;
    }
    case "order.confirmed":
      await notify(customerPhone, "Pedido " + reference + " confirmado pela padaria para retirada " + dateTime + "." + testNote(order, payload.order?.notes), "order-confirmed-customer", orderId, event.event_type, warnings);
      await notifyProductionSectors(order, payload.items, settings, reference, dateTime, orderId, warnings);
      break;
    case "order.rejected":
      if (payload.notify_fiscal !== false) {
        await notify(settings.fiscal_phone_e164, "O pedido " + reference + " foi encerrado no painel após a operação registrar a decisão." + (payload.reason ? " Motivo: " + payload.reason : ""), "order-rejected-fiscal", orderId, event.event_type, warnings);
      }
      break;
    case "order.cancelled":
      await notify(customerPhone, "O pedido " + reference + " foi cancelado.", "order-cancelled-customer", orderId, event.event_type, warnings);
      await notify(settings.fiscal_phone_e164, "O pedido " + reference + " foi cancelado.", "order-cancelled-fiscal", orderId, event.event_type, warnings);
      break;
    case "production.started":
      if (payload.production?.notify_customer !== false) {
        await notify(customerPhone, "A produção do pedido " + reference + " começou. Avisaremos quando estiver pronto." + testNote(order, payload.order?.notes), "production-started-customer", orderId, event.event_type, warnings);
      }
      break;
    case "production.issue":
      await notify(settings.fiscal_phone_e164, "Atenção no pedido " + reference + ", setor " + (payload.production?.sector || payload.sector || "não informado") + ": " + (payload.reason || payload.production?.reason || ""), "production-issue-fiscal", orderId, event.event_type, warnings);
      break;
    case "production.completed":
      if (orderId && await orderReady(orderId)) {
        await notify(customerPhone, "O pedido " + reference + " está pronto para retirada!" + testNote(order, payload.order?.notes), "production-ready-customer", orderId, event.event_type, warnings);
        await notify(settings.fiscal_phone_e164, "Pedido " + reference + " pronto para retirada." + testNote(order, payload.order?.notes), "production-ready-fiscal", orderId, event.event_type, warnings);
      }
      break;
    case "order.fulfilled":
      {
      const jobKey = "survey:" + event.order_ref;
      try {
        const claimed = await claimAutomationRun(jobKey, "satisfaction_survey", event.order_ref);
        if (!claimed) break;
        const runId = await startSatisfactionWorkflow(event.order_ref);
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

function itemSector(item) {
  const related = firstRecord(item?.sector);
  return { id: item?.sector_id || related.id || "", name: related.name || item?.sector_name || item?.sector || "Setor", slug: related.slug || "" };
}

async function notifyProductionSectors(order, fallbackItems, settings, reference, dateTime, orderId, warnings) {
  let sectors;
  try { sectors = await getActiveSectors(); }
  catch (error) {
    warnings.push({ channel: "production-routing", tag: "sector-list", message: "Pedido confirmado, mas não foi possível carregar os setores para encaminhar os itens." });
    console.error("Falha ao carregar setores de produção: " + error.message);
    return;
  }
  const sectorById = new Map((sectors || []).map(sector => [String(sector.id), sector]));
  const items = asArray(order.items || order.order_items || fallbackItems);
  if (!items.length) {
    warnings.push({ channel: "production-routing", tag: "sector-items", message: "Pedido confirmado, mas os itens não estavam disponíveis para encaminhamento por setor." });
    return;
  }
  const routes = new Map();
  for (const item of items) {
    const linked = itemSector(item);
    const sector = sectorById.get(String(linked.id)) || linked;
    const routeLabel = [sector.slug, sector.name || linked.name].filter(Boolean).join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
    const routeKey = /acougue|butcher/.test(routeLabel) ? "butcher" : /frios|cold.?cuts/.test(routeLabel) ? "cold_cuts" : "bakery";
    if (!routes.has(routeKey)) routes.set(routeKey, { sectorNames: new Set(), items: [] });
    const route = routes.get(routeKey);
    route.sectorNames.add(sector.name || linked.name || "Produção");
    route.items.push(item);
  }
  for (const [routeKey, route] of routes) {
    const settingsKey = routeKey === "butcher" ? "butcher_phone_e164" : routeKey === "cold_cuts" ? "cold_cuts_phone_e164" : "bakery_phone_e164";
    const label = Array.from(route.sectorNames).join(", ");
    const tag = "production-sector-" + routeKey;
    const phone = settings[settingsKey];
    if (!phone) {
      warnings.push({ channel: "whatsapp", tag, message: "Cadastre o WhatsApp de " + label + " nas configurações para receber os itens deste setor." });
      continue;
    }
    const message = "PRODUÇÃO · " + label.toLocaleUpperCase("pt-BR") + "\nPedido: " + reference + "\nRetirada: " + dateTime + "\n\nItens deste setor:\n" + formatItems(route.items) + testNote(order);
    await notify(phone, message, tag, orderId, "order.confirmed", warnings);
  }
}

async function requestFiscalReview(orderRef, reason = "") {
  const order = await getOrderByReference(String(orderRef || "").trim());
  if (!order) throw Object.assign(new Error("Pedido não encontrado para revisão."), { statusCode: 404 });
  const settings = await getOperationSettings();
  const reference = order.display_id || order.external_order_id || order.id || orderRef;
  const warnings = [];
  if (!settings.fiscal_phone_e164) {
    warnings.push({ channel: "whatsapp", tag: "fiscal-review", message: "Cadastre o WhatsApp da fiscal para receber pedidos em revisão." });
  } else {
    await notify(settings.fiscal_phone_e164,
      "REVISÃO DE PEDIDO " + reference + ". A padaria sinalizou que pode haver um impedimento." + (reason ? " Motivo informado: " + String(reason).slice(0, 500) : "") + " Converse com a equipe. Se for possível atender, peça à padaria para responder CONFIRMAR " + reference + ". Avise o cliente pessoalmente somente se concluir que não será possível entregar.",
      "order-review-fiscal", order.id || null, "order.review_requested", warnings);
  }
  try {
    await audit({ order_id: order.id || null, event_type: "order.review_requested", action: "fiscal_review_requested", details: { order_ref: reference, reason: String(reason || "").slice(0, 500) }, occurred_at: new Date().toISOString() });
  } catch (error) { console.error("Falha ao gravar auditoria da revisão fiscal: " + error.message); }
  return { ok: true, review_required: true, warnings };
}

async function dispatchEvent(input) {
  const event = validateEvent(input);
  if (event.event_type === "order.created") {
    const activeSectors = await getActiveSectors();
    const activeSectorIds = new Set((activeSectors || []).map(sector => String(sector.id)));
    if (asArray(event.payload.items).some(item => !activeSectorIds.has(String(item.sector_id)))) {
      throw Object.assign(new Error("Um ou mais produtos estão atribuídos a um setor inativo ou inexistente."), { statusCode: 422 });
    }
    const customer = event.payload.customer;
    await upsertCustomer(customer.name.trim(), customer.phone_e164);
  }

  const result = await rpc("dashboard_process_event", {
    p_event_id: event.event_id,
    p_event_type: event.event_type,
    p_order_ref: event.order_ref,
    p_payload: event.payload
  });
  const resultRow = firstRecord(result);
  if (resultRow.ok === false || resultRow.success === false || resultRow.error) {
    throw Object.assign(new Error("O evento não foi aceito pelas regras operacionais."), { statusCode: 422 });
  }

  const settings = await getOperationSettings();
  const order = await loadOrder(event.order_ref, event) || {};
  if (event.event_type === "order.confirmed") {
    try { await updateProductionAgenda(order); }
    catch (error) {
      console.error("Falha ao atualizar a agenda de produção: " + error.message);
      throw Object.assign(new Error("O pedido foi confirmado, mas a agenda de produção não foi atualizada."), { statusCode: 502 });
    }
  }
  const warnings = [];
  await notifyForEvent(event, order, settings, warnings);
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
  return { ok: true, result, warnings };
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
      name: typeof (item.name || item.product_name) === "string" ? String(item.name || item.product_name).trim() : "",
      quantity: Number(item.quantity),
      ...(item.sector_id ? { sector_id: item.sector_id } : {}),
      ...(typeof item.sector === "string" ? { sector: item.sector.slice(0, 120) } : {})
    };
  });
  const orderRef = String(body.order_ref || order.id || "ENC-" + crypto.randomUUID().toUpperCase());
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

module.exports = { actionEvent, createOrderEvent, dispatchEvent, requestFiscalReview, validateEvent };

