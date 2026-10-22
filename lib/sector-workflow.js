"use strict";

const { rest, rpc } = require("./supabase");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstRecord(value) {
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === "object" ? value : {};
}

function relation(value) {
  return Array.isArray(value) ? value[0] || {} : value && typeof value === "object" ? value : {};
}

function requestEventId(value) {
  const candidate = String(value || "");
  if (!UUID.test(candidate)) throw Object.assign(new Error("Identificador de ação inválido. Atualize a página e tente novamente."), { statusCode: 422 });
  return candidate;
}

function idsFilter(values) {
  const ids = Array.from(new Set((values || []).map(String).filter(id => UUID.test(id))));
  return ids.length ? `in.(${ids.join(",")})` : "in.(00000000-0000-4000-8000-000000000000)";
}

function itemCard(item) {
  return {
    id: item.id,
    sector_id: String(item.sector_id || ""),
    name: item.name,
    quantity: Number(item.quantity) || 1,
    size_label: item.size_label || ""
  };
}

function baseOrder(row, items = []) {
  const order = relation(row.order || row);
  return {
    order_id: String(order.id || row.order_id || ""),
    order_ref: String(order.display_id || order.id || ""),
    display_id: String(order.display_id || "Pedido"),
    status: String(order.status || ""),
    requested_date: String(order.requested_date || ""),
    requested_time: String(order.requested_time || ""),
    pickup_location: String(order.pickup_location || ""),
    customer: { name: String(order.customer_name || "Cliente"), phone: String(order.customer_phone || "") },
    items: (items || []).map(itemCard)
  };
}

function rowMap(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const id = String(row[key] || "");
    if (!id) continue;
    const list = map.get(id) || [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}

async function getPortalOrders(orderIds) {
  if (!orderIds?.length) return [];
  return rest("/rest/v1/sector_portal_orders?" + new URLSearchParams({
    select: "id,display_id,status,customer_name,customer_phone,requested_date,requested_time,pickup_location,confirmation_sector_id,created_at",
    id: idsFilter(orderIds),
    order: "requested_date.asc,requested_time.asc,created_at.asc",
    limit: "500"
  }));
}

async function getPortalItems(orderIds, sectorId = null) {
  if (!orderIds?.length) return [];
  const query = new URLSearchParams({
    select: "id,order_id,sector_id,name,quantity,size_label",
    order_id: idsFilter(orderIds),
    order: "id.asc",
    limit: "2000"
  });
  if (sectorId) query.set("sector_id", "eq." + sectorId);
  return rest("/rest/v1/sector_portal_order_items?" + query);
}

async function sectorWorkboard(account) {
  if (account.role === "fiscal") {
    const reviews = await rest("/rest/v1/sector_portal_reviews?" + new URLSearchParams({
      select: "id,order_id,sector_id,requested_by,reason,status,fiscal_resolution,created_at",
      status: "eq.pending",
      order: "created_at.asc",
      limit: "100"
    }));
    const orderIds = (reviews || []).map(row => row.order_id);
    const [orders, items] = await Promise.all([getPortalOrders(orderIds), getPortalItems(orderIds)]);
    const orderById = new Map((orders || []).map(row => [String(row.id), row]));
    const itemsByOrder = rowMap(items, "order_id");
    const sectors = await rest("/rest/v1/sector_portal_sectors?" + new URLSearchParams({ select: "id,name", id: idsFilter((reviews || []).map(row => row.sector_id)) }));
    const sectorById = new Map((sectors || []).map(row => [String(row.id), row.name]));
    return {
      role: "fiscal",
      data: (reviews || []).flatMap(review => {
        const order = orderById.get(String(review.order_id));
        if (!order) return [];
        const card = baseOrder(order, itemsByOrder.get(String(order.id)) || []);
        card.review = {
          id: review.id,
          sector_id: review.sector_id,
          sector_name: sectorById.get(String(review.sector_id)) || "Setor",
          reason: review.reason || "",
          status: review.status,
          fiscal_resolution: review.fiscal_resolution || "",
          created_at: review.created_at
        };
        card.items = card.items.filter(item => item.sector_id === String(review.sector_id));
        return [card];
      })
    };
  }

  if (account.role !== "sector" || !account.sector_id) {
    throw Object.assign(new Error("A conta não tem um setor autorizado."), { statusCode: 403 });
  }

  const assignments = await rest("/rest/v1/sector_portal_order_sectors?" + new URLSearchParams({
    select: "order_id,sector_id,stage,previous_stage,order:sector_portal_orders!inner(id,display_id,status,customer_name,customer_phone,requested_date,requested_time,pickup_location,confirmation_sector_id,created_at)",
    sector_id: "eq." + account.sector_id,
    "order.status": "not.eq.cancelled",
    order: "updated_at.asc",
    limit: "500"
  }));
  const orderIds = (assignments || []).map(row => row.order_id);
  const [items, reviews] = await Promise.all([
    getPortalItems(orderIds, account.sector_id),
    orderIds.length ? rest("/rest/v1/sector_portal_reviews?" + new URLSearchParams({
      select: "id,order_id,status,reason,fiscal_resolution,created_at",
      order_id: idsFilter(orderIds),
      status: "in.(pending,returned_to_sector)",
      order: "created_at.asc",
      limit: "500"
    })) : Promise.resolve([])
  ]);
  const itemsByOrder = rowMap(items, "order_id");
  const reviewsByOrder = rowMap(reviews, "order_id");
  const data = (assignments || []).map(row => {
    const card = baseOrder(row, itemsByOrder.get(String(row.order_id)) || []);
    card.sector_id = String(row.sector_id);
    card.sector_name = account.sector_name;
    card.stage = row.stage;
    card.reviews = reviewsByOrder.get(String(row.order_id)) || [];
    return card;
  });
  return { role: "sector", data };
}

async function applySectorAction(account, body) {
  const action = String(body?.action || "");
  if (account.role === "fiscal") {
    if (!["fiscal_possible", "fiscal_impossible"].includes(action)) {
      throw Object.assign(new Error("A conta da Fiscal só pode resolver análises pendentes."), { statusCode: 422 });
    }
    const reviewId = String(body.review_id || "");
    if (!UUID.test(reviewId)) throw Object.assign(new Error("Identificador de análise inválido."), { statusCode: 422 });
    const resolution = String(body.resolution || "").trim();
    if (!resolution || resolution.length > 1000) throw Object.assign(new Error("Descreva a decisão da análise."), { statusCode: 422 });
    const result = firstRecord(await rpc("sector_portal_apply_action", {
      p_event_id: requestEventId(body.event_id),
      p_action: action,
      p_actor_user_id: account.auth_user_id,
      p_order_id: null,
      p_sector_id: null,
      p_review_id: reviewId,
      p_reason: resolution
    }));
    return { ok: true, result };
  }

  if (account.role !== "sector" || !account.sector_id) {
    throw Object.assign(new Error("Esta conta não pode atualizar a fila."), { statusCode: 403 });
  }
  if (!["confirm", "start_preparing", "mark_ready", "request_review"].includes(action)) {
    throw Object.assign(new Error("Ação não permitida para este setor."), { statusCode: 422 });
  }
  const orderId = String(body.order_id || "");
  if (!UUID.test(orderId)) throw Object.assign(new Error("Identificador do pedido inválido."), { statusCode: 422 });
  const reason = String(body.reason || "").trim();
  if (reason.length > 500) throw Object.assign(new Error("O motivo pode ter até 500 caracteres."), { statusCode: 422 });
  if (action === "request_review" && !reason) throw Object.assign(new Error("Descreva o impedimento para a Fiscal analisar."), { statusCode: 422 });

  const result = firstRecord(await rpc("sector_portal_apply_action", {
    p_event_id: requestEventId(body.event_id),
    p_action: action,
    p_actor_user_id: account.auth_user_id,
    p_order_id: orderId,
    p_sector_id: account.sector_id,
    p_review_id: null,
    p_reason: reason
  }));
  return { ok: true, result };
}

async function createPortalOrder(account, body) {
  if (account.role !== "manager") throw Object.assign(new Error("Somente a gerência pode cadastrar encomendas."), { statusCode: 403 });
  const data = body?.order && typeof body.order === "object" ? body.order : {};
  const lines = Array.isArray(body?.items) ? body.items : [];
  if (lines.length < 1 || lines.length > 100) throw Object.assign(new Error("Adicione de 1 a 100 itens à encomenda."), { statusCode: 422 });
  const normalizedItems = lines.map((item, index) => ({
    name: String(item?.name || "").trim(),
    quantity: Number(item?.quantity),
    size_label: String(item?.size_label || "").trim(),
    sector_id: String(item?.sector_id || "")
  }));
  if (normalizedItems.some(item => !item.name || item.name.length > 160 || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 100000 || !UUID.test(item.sector_id) || item.size_label.length > 120)) {
    throw Object.assign(new Error("Revise o nome, quantidade, setor e tamanho de cada item."), { statusCode: 422 });
  }
  const order = {
    customer_name: String(data.customer_name || "").trim(),
    customer_phone: String(data.customer_phone || "").trim(),
    requested_date: String(data.requested_date || ""),
    requested_time: String(data.requested_time || ""),
    pickup_location: String(data.pickup_location || "").trim()
  };
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(order.requested_date);
  let validDate = false;
  if (dateParts) {
    const [, yearText, monthText, dayText] = dateParts;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(0);
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCFullYear(year, month - 1, day);
      validDate = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    }
  }
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(order.requested_time);
  if (!order.customer_name || order.customer_name.length > 120 || order.customer_phone.length > 40 ||
      !validDate || !validTime || order.pickup_location.length > 240) {
    throw Object.assign(new Error("Preencha cliente, data, horário e local de retirada válidos."), { statusCode: 422 });
  }
  const result = firstRecord(await rpc("sector_portal_create_order", {
    p_event_id: requestEventId(body.event_id),
    p_actor_user_id: account.auth_user_id,
    p_order: order,
    p_items: normalizedItems
  }));
  return { ok: true, order: result.order || result };
}

module.exports = { applySectorAction, createPortalOrder, sectorWorkboard };
