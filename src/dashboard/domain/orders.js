export const STATUS = Object.freeze({
  awaiting_confirmation: "Aguardando confirmação",
  confirmed: "Aguardando produção",
  preparing: "Em fabricação",
  needs_attention: "Precisa de atenção",
  ready: "Pronto para retirada",
  rejected: "Recusado",
  cancelled: "Cancelado",
  picked_up: "Retirado"
});

export const terminalStatuses = new Set(["picked_up", "rejected", "cancelled"]);
export const agendaStatuses = new Set(["confirmed", "preparing", "needs_attention", "ready"]);
export const today = new Date();

export function localDateISO(offsetDays) {
  const value = new Date();
  value.setDate(value.getDate() + offsetDays);
  return value.getFullYear() + "-" + String(value.getMonth() + 1).padStart(2, "0") + "-" + String(value.getDate()).padStart(2, "0");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function firstRecord(value) {
  return Array.isArray(value) ? value[0] || {} : value || {};
}

function itemName(item, fallback = "Produto") {
  const product = firstRecord(item?.product);
  return [item?.name, item?.product_name, product.name]
    .find(value => typeof value === "string" && value.trim()) || fallback;
}

export function orderItemLabel(item) {
  if (typeof item === "string") return item;
  const productSize = firstRecord(item?.product_size);
  const sizeRelation = firstRecord(item?.size);
  const name = itemName(item);
  const size = [item?.sizeLabel, item?.size_label, productSize.label,
    typeof item?.size === "string" ? item.size : "", sizeRelation.label]
    .find(value => typeof value === "string" && value.trim()) || "";
  const normalizeForComparison = value => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]/g, "");
  const normalizedSize = normalizeForComparison(size);
  const sizeAlreadyInName = Boolean(normalizedSize && normalizeForComparison(name).endsWith(normalizedSize));
  return String(item?.quantity ?? 1) + "× " + String(name) + (size && !sizeAlreadyInName ? " · " + size : "");
}

export function prettyDate(value) {
  if (!value) return "Sem data";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(String(value) + "T00:00:00") : new Date(value);
  if (Number.isNaN(date.getTime())) return "Sem data";
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const prefix = sameDay ? "Hoje, " : date.toDateString() === yesterday.toDateString() ? "Ontem, " : "";
  return prefix + new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date);
}

export function localDateFromISO(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dateKey(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

export function startOfWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return start;
}

export function shortDate(date) {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date).replace(".", "");
}

export function normalizeStatus(value) {
  const aliases = { pending: "awaiting_confirmation", accepted: "confirmed", in_progress: "preparing", in_production: "preparing", completed: "ready", collected: "picked_up", fulfilled: "picked_up", refused: "rejected", blocked: "needs_attention", needs_attention: "needs_attention" };
  const status = aliases[String(value || "").toLowerCase()] || String(value || "").toLowerCase();
  return STATUS[status] ? status : "awaiting_confirmation";
}

export function normalizeOrder(row) {
  const customer = row.customer || {};
  const items = Array.isArray(row.items) && row.items.length
    ? row.items
    : Array.isArray(row.order_items) ? row.order_items : [];
  return {
    id: row.display_id || row.external_order_id || row.order_number || row.id || "Sem identificação",
    customer: customer.name || row.customer_name || "Cliente",
    phone: customer.phone_e164 || customer.phone || row.customer_phone || "",
    fiscalPhone: row.fiscal_phone_e164 || row.fiscal_phone || row.fiscalPhone || "",
    items: Array.isArray(items) ? items.map(item => {
      if (typeof item === "string") return { name: item, quantity: 1, sizeLabel: "", sector: "", sectorId: "" };
      const sector = firstRecord(item?.sector);
      const productSize = firstRecord(item?.product_size);
      const size = item?.size_label || productSize.label || (typeof item?.size === "string" ? item.size : firstRecord(item?.size).label) || "";
      return {
        name: itemName(item),
        quantity: item?.quantity ?? 1,
        sizeLabel: String(size).trim(),
        sector: sector.name || item?.sector_name || "",
        sectorId: item?.sector_id || sector.id || ""
      };
    }) : [],
    itemsSummary: row.items_summary || row.item_summary || "",
    sector: row.sector_name || row.sector?.name || "",
    pickupDate: row.requested_date || row.pickup_date || row.scheduled_for || row.pickup_at || "",
    pickupTime: row.requested_time || row.pickup_time || row.scheduled_time || "",
    pickupLocation: row.pickup_location || row.delivery_address || "",
    status: normalizeStatus(row.status),
    productionRefused: row.production_refused === true,
    notes: row.notes || "",
    dueAt: row.due_at || row.dueAt || "",
    createdAt: row.created_at || ""
  };
}

export function phoneToE164(rawValue) {
  let digits = String(rawValue || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  if (!digits.startsWith("55") || (digits.length !== 12 && digits.length !== 13)) {
    throw new Error("Informe um WhatsApp brasileiro com DDD, como +55 11 99999-9999.");
  }
  return "+" + digits;
}

export function isOverdue(order) {
  if (terminalStatuses.has(order.status) || order.status === "ready") return false;
  let deadline = order.dueAt ? new Date(order.dueAt) : null;
  if ((!deadline || Number.isNaN(deadline.getTime())) && order.pickupDate && order.pickupTime) {
    const localDate = localDateFromISO(order.pickupDate);
    const [hours, minutes] = String(order.pickupTime).split(":").map(Number);
    if (localDate && Number.isFinite(hours) && Number.isFinite(minutes)) {
      localDate.setHours(hours, minutes, 0, 0);
      deadline = localDate;
    }
  }
  return Boolean(deadline && !Number.isNaN(deadline.getTime()) && deadline.getTime() < Date.now());
}

export function orderItemsLabel(order) {
  const details = order.items.map(orderItemLabel).join(" · ");
  return details || order.itemsSummary || "Itens não informados";
}

export function availableActions(order) {
  const actions = {
    awaiting_confirmation: [
      ...(!order.productionRefused ? [{ action: "request_review", label: "Pedir análise da fiscal" }] : []),
      ...(order.productionRefused ? [{ action: "accept", label: "Confirmar pedido" }] : [])
    ],
    ready: [{ action: "fulfill", label: "Confirmar retirada" }]
  };
  return actions[order.status] || [];
}
