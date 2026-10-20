import { STATUS, agendaStatuses, dateKey, escapeHtml, isOverdue, localDateFromISO, orderItemsLabel, shortDate, startOfWeek } from "../domain/orders.js";

export function createAgendaView({ getOrders, getAgendaDate, setAgendaDate, getAgendaMode, setAgendaModeState, getSearchQuery, getStatusFilter, onOpenOrder }) {
  const content = document.getElementById("agenda-content");
  const periodLabel = document.getElementById("agenda-period-label");

  function renderOrderCard(order) {
    const overdue = isOverdue(order);
    return "<button type=\"button\" class=\"agenda-order" + (overdue ? " is-overdue" : "") + " data-order-id=\"" + escapeHtml(order.id) + "\" aria-label=\"Abrir pedido " + escapeHtml(order.id) + "\">" +
      "<span class=\"agenda-order-top\"><span class=\"agenda-order-time\">" + escapeHtml(order.pickupTime || "Horário a combinar") + "</span><span class=\"status-pill status-" + escapeHtml(order.status) + "\">" + escapeHtml(overdue ? "Atrasado" : STATUS[order.status]) + "</span></span>" +
      "<strong>" + escapeHtml(order.id) + " · " + escapeHtml(order.customer) + "</strong>" +
      "<span class=\"agenda-order-items\">" + escapeHtml(orderItemsLabel(order)) + "</span>" +
      "<span class=\"agenda-order-sector\">" + escapeHtml(order.sector ? "Setor: " + order.sector : "Setor de produção") + "</span></button>";
  }

  function ordersForAgenda() {
    const query = getSearchQuery().trim().toLocaleLowerCase("pt-BR");
    const status = getStatusFilter();
    return getOrders().filter(order => {
      if (!agendaStatuses.has(order.status)) return false;
      if (status !== "all" && order.status !== status) return false;
      if (query && ![order.id, order.customer, order.phone, orderItemsLabel(order), order.sector].join(" ").toLocaleLowerCase("pt-BR").includes(query)) return false;
      return true;
    }).sort((a, b) => (String(a.pickupDate) + a.pickupTime).localeCompare(String(b.pickupDate) + b.pickupTime));
  }

  function renderAgenda() {
    const rows = ordersForAgenda();
    const agendaDate = getAgendaDate();
    if (getAgendaMode() === "day") {
      const selectedKey = dateKey(agendaDate);
      periodLabel.textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(agendaDate);
      const dayOrders = rows.filter(order => {
        const date = localDateFromISO(order.pickupDate);
        return date && dateKey(date) === selectedKey;
      });
      content.className = "agenda-content agenda-day-view";
      content.innerHTML = dayOrders.length
        ? dayOrders.map(renderOrderCard).join("")
        : "<div class=\"agenda-empty\"><strong>Nenhuma encomenda aceita neste dia</strong><span>Os pedidos entram na agenda depois que o setor confirmar o atendimento.</span></div>";
    } else {
      const weekStart = startOfWeek(agendaDate);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      periodLabel.textContent = shortDate(weekStart) + " – " + shortDate(weekEnd) + " de " + weekEnd.getFullYear();
      const dayCards = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(weekStart);
        date.setDate(weekStart.getDate() + index);
        const dayOrders = rows.filter(order => {
          const orderDate = localDateFromISO(order.pickupDate);
          return orderDate && dateKey(orderDate) === dateKey(date);
        });
        return "<section class=\"agenda-week-day\"><button type=\"button\" class=\"agenda-week-date\" data-agenda-date=\"" + dateKey(date) + "\"><span>" + escapeHtml(new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(date).replace(".", "")) + "</span><strong>" + date.getDate() + "</strong><small>" + dayOrders.length + (dayOrders.length === 1 ? " pedido" : " pedidos") + "</small></button><div class=\"agenda-week-orders\">" + (dayOrders.length ? dayOrders.map(renderOrderCard).join("") : "<span class=\"agenda-week-empty\">—</span>") + "</div></section>";
      }).join("");
      content.className = "agenda-content agenda-week-view";
      content.innerHTML = dayCards;
      content.querySelectorAll("[data-agenda-date]").forEach(button => button.addEventListener("click", () => {
        setAgendaDate(localDateFromISO(button.dataset.agendaDate) || agendaDate);
        setAgendaMode("day");
      }));
    }
    content.querySelectorAll("[data-order-id]").forEach(button => button.addEventListener("click", () => onOpenOrder(button.dataset.orderId)));
  }

  function setAgendaMode(mode) {
    setAgendaModeState(mode);
    document.querySelectorAll("[data-agenda-mode]").forEach(button => {
      const selected = button.dataset.agendaMode === mode;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    renderAgenda();
  }

  function moveAgenda(amount) {
    const agendaDate = getAgendaDate();
    agendaDate.setDate(agendaDate.getDate() + amount * (getAgendaMode() === "week" ? 7 : 1));
    setAgendaDate(agendaDate);
    renderAgenda();
  }

  return { renderAgenda, setAgendaMode, moveAgenda };
}
