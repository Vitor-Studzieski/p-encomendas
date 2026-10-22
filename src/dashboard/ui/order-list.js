import { STATUS, escapeHtml, localDateISO, orderItemLabel, prettyDate, terminalStatuses } from "../domain/orders.js";

export function createOrderListRenderer({ getOrders, getActiveView, onOpenOrder }) {
  const table = document.getElementById("orders-table");
  const board = document.getElementById("overview-board");
  const tableView = document.getElementById("orders-table-view");
  const ordersSection = document.getElementById("orders-section");
  const searchInput = document.getElementById("search-input");
  const statusFilter = document.getElementById("status-filter");
  const dateFilter = document.getElementById("date-filter");

  const overviewLanes = [
    { id: "confirmation", title: "Aguardando resposta", statuses: ["awaiting_confirmation", "needs_attention"] },
    { id: "queued", title: "Aguardando produção", statuses: ["confirmed"] },
    { id: "production", title: "Em produção", statuses: ["preparing"] },
    { id: "ready", title: "Prontos para retirada", statuses: ["ready"] },
    { id: "closed", title: "Encerrados", statuses: ["picked_up", "rejected", "cancelled"] }
  ];

  function filteredOrders() {
    let rows = getOrders().slice();
    const query = searchInput.value.trim().toLocaleLowerCase("pt-BR");
    const status = statusFilter.value;
    if (getActiveView() === "history") rows = rows.filter(order => terminalStatuses.has(order.status));
    if (getActiveView() === "orders") rows = rows.filter(order => !terminalStatuses.has(order.status));
    if (status !== "all") rows = rows.filter(order => order.status === status);
    if (dateFilter.value === "today") {
      rows = rows.filter(order => {
        if (!order.pickupDate) return false;
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(order.pickupDate))
          ? String(order.pickupDate)
          : new Date(order.pickupDate).toLocaleDateString("en-CA");
        return date === localDateISO(0);
      });
    }
    if (query) rows = rows.filter(order => [order.id, order.customer, order.phone, order.items.map(orderItemLabel).join(" "), order.itemsSummary, order.sector].join(" ").toLocaleLowerCase("pt-BR").includes(query));
    return rows.sort((a, b) => (String(a.pickupDate) + a.pickupTime).localeCompare(String(b.pickupDate) + b.pickupTime));
  }

  function renderRows() {
    const orders = getOrders();
    const rows = filteredOrders();
    const isOverview = getActiveView() === "overview";
    table.innerHTML = rows.map(order => {
      const itemsText = order.items.map(orderItemLabel).join(" · ") || order.itemsSummary;
      const initials = order.customer.split(/\s+/).slice(0, 2).map(name => name[0] || "").join("").toUpperCase();
      return "<tr>" +
        "<td data-label=\"Encomenda\"><span class=\"order-id\">" + escapeHtml(order.id) + "</span><span class=\"order-date\">" + escapeHtml(prettyDate(order.pickupDate)) + "</span></td>" +
        "<td data-label=\"Cliente\"><div class=\"customer-cell\"><span class=\"customer-avatar\" aria-hidden=\"true\">" + escapeHtml(initials) + "</span><span><span class=\"customer-name\">" + escapeHtml(order.customer) + "</span><span class=\"customer-phone\">" + escapeHtml(order.phone || "—") + "</span></span></div></td>" +
        "<td data-label=\"Itens\"><div class=\"items-text\">" + escapeHtml(itemsText || "Itens não informados") + "</div></td>" +
        "<td data-label=\"Retirada\"><span class=\"pickup-time\">" + escapeHtml(order.pickupTime || "A combinar") + "</span><span class=\"pickup-day\">" + escapeHtml(order.pickupLocation || prettyDate(order.pickupDate)) + "</span></td>" +
        "<td data-label=\"Etapa\"><span class=\"status-pill status-" + escapeHtml(order.status) + "\">" + escapeHtml(STATUS[order.status]) + "</span></td>" +
        "<td data-label=\"Ações\"><button class=\"row-action\" data-order-id=\"" + escapeHtml(order.id) + "\" aria-label=\"Abrir pedido " + escapeHtml(order.id) + "\" type=\"button\">•••</button></td></tr>";
    }).join("");

    board.hidden = !isOverview;
    tableView.hidden = isOverview;
    document.getElementById("empty-state").hidden = isOverview || rows.length > 0;
    if (isOverview) {
      const lanesHtml = overviewLanes.map(lane => {
        const laneOrders = rows.filter(order => lane.statuses.includes(order.status));
        const cards = laneOrders.map(order => {
          const itemsText = order.items.map(orderItemLabel).join(" · ") || order.itemsSummary || "Itens não informados";
          return "<article class=\"kanban-order kanban-order-" + escapeHtml(order.status) + "\">" +
            "<header class=\"kanban-order-head\"><strong>" + escapeHtml(order.id) + "</strong><span>" + escapeHtml(order.pickupTime || "A combinar") + "</span></header>" +
            "<div class=\"kanban-order-customer\">" + escapeHtml(order.customer) + "</div>" +
            "<div class=\"kanban-order-phone\">" + escapeHtml(order.phone || "WhatsApp não informado") + "</div>" +
            "<p class=\"kanban-order-items\">" + escapeHtml(itemsText) + "</p>" +
            "<div class=\"kanban-order-place\"><span>Retirada</span>" + escapeHtml(order.pickupLocation || "Na loja") + "</div>" +
            "<div class=\"kanban-order-meta\"><span>" + escapeHtml(prettyDate(order.pickupDate)) + "</span><span class=\"status-pill status-" + escapeHtml(order.status) + "\">" + escapeHtml(STATUS[order.status]) + "</span></div>" +
            "<button class=\"kanban-order-open\" data-order-id=\"" + escapeHtml(order.id) + "\" type=\"button\">Abrir encomenda <span aria-hidden=\"true\">→</span></button>" +
            "</article>";
        }).join("");
        return "<section class=\"kanban-lane kanban-lane-" + lane.id + "\" aria-label=\"" + escapeHtml(lane.title) + "\"><header class=\"kanban-lane-head\"><h3>" + escapeHtml(lane.title) + "</h3><span>" + String(laneOrders.length).padStart(2, "0") + "</span></header><div class=\"kanban-lane-content\">" + (cards || "<p class=\"kanban-lane-empty\">Sem encomendas</p>") + "</div></section>";
      }).join("");
      const emptyMessage = rows.length
        ? ""
        : "<div class=\"kanban-board-empty\"><span>Nenhuma encomenda para estes filtros.</span><button class=\"text-button\" id=\"clear-board-filters\" type=\"button\">Limpar filtros</button></div>";
      board.innerHTML = emptyMessage + "<div class=\"kanban-lanes\">" + lanesHtml + "</div>";
    } else {
      board.innerHTML = "";
    }
    document.getElementById("result-count").textContent = "Mostrando " + rows.length + (rows.length === 1 ? " pedido" : " pedidos");
    document.getElementById("nav-order-count").textContent = String(orders.length).padStart(2, "0");
    document.getElementById("metric-total").textContent = String(orders.filter(order => !terminalStatuses.has(order.status)).length).padStart(2, "0");
    document.getElementById("metric-pending").textContent = String(orders.filter(order => order.status === "awaiting_confirmation").length).padStart(2, "0");
    document.getElementById("metric-preparing").textContent = String(orders.filter(order => order.status === "preparing").length).padStart(2, "0");
    document.getElementById("metric-ready").textContent = String(orders.filter(order => order.status === "ready").length).padStart(2, "0");
    ordersSection.querySelectorAll("[data-order-id]").forEach(button => button.addEventListener("click", () => onOpenOrder(button.dataset.orderId)));
  }

  return { filteredOrders, renderRows };
}
