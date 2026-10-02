const STATUS = {
  awaiting_confirmation: "Aguardando confirmação",
  confirmed: "Aceito pela cozinha",
  preparing: "Em preparo",
  needs_attention: "Precisa de atenção",
  ready: "Pronto para retirada",
  rejected: "Recusado",
  cancelled: "Cancelado",
  picked_up: "Retirado"
};
const terminalStatuses = new Set(["picked_up", "rejected", "cancelled"]);
const today = new Date();

function localDateISO(offsetDays) {
  const value = new Date();
  value.setDate(value.getDate() + offsetDays);
  return value.getFullYear() + "-" + String(value.getMonth() + 1).padStart(2, "0") + "-" + String(value.getDate()).padStart(2, "0");
}

const config = window.ORDER_DASHBOARD_CONFIG || {};
const apiTokenStorageKey = "order-dashboard-api-token";
const table = document.getElementById("orders-table");
const searchInput = document.getElementById("search-input");
const statusFilter = document.getElementById("status-filter");
const dateFilter = document.getElementById("date-filter");
const orderDialog = document.getElementById("order-dialog");
const newOrderDialog = document.getElementById("new-order-dialog");
const apiAccessDialog = document.getElementById("api-access-dialog");
const apiTokenInput = document.getElementById("api-token-input");
let orders = [];
let activeView = "overview";
let usingDemoData = false;
let connectionMode = "disconnected";
let contactsLoaded = false;
let toastTimer;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function prettyDate(value) {
  if (!value) return "Sem data";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(String(value) + "T00:00:00") : new Date(value);
  if (Number.isNaN(date.getTime())) return "Sem data";
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const prefix = sameDay ? "Hoje, " : date.toDateString() === yesterday.toDateString() ? "Ontem, " : "";
  return prefix + new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date);
}

function normalizeStatus(value) {
  const aliases = { pending: "awaiting_confirmation", accepted: "confirmed", in_progress: "preparing", in_production: "preparing", completed: "ready", collected: "picked_up", fulfilled: "picked_up", refused: "rejected", blocked: "needs_attention", needs_attention: "needs_attention" };
  const status = aliases[String(value || "").toLowerCase()] || String(value || "").toLowerCase();
  return STATUS[status] ? status : "awaiting_confirmation";
}

function normalizeOrder(row) {
  const customer = row.customer || {};
  const items = row.items || row.order_items || [];
  return {
    id: row.external_order_id || row.order_number || row.id || "Sem identificação",
    customer: customer.name || row.customer_name || "Cliente",
    phone: customer.phone_e164 || customer.phone || row.customer_phone || "",
    fiscalPhone: row.fiscal_phone_e164 || row.fiscal_phone || row.fiscalPhone || "",
    items: Array.isArray(items) ? items.map(item => ({ name: item.product_name || item.product?.name || item.name || "Produto", quantity: item.quantity ?? 1, sector: item.sector?.name || item.sector_name || "" })) : [],
    pickupDate: row.requested_date || row.pickup_date || row.scheduled_for || row.pickup_at || "",
    pickupTime: row.requested_time || row.pickup_time || row.scheduled_time || "",
    pickupLocation: row.pickup_location || "",
    status: normalizeStatus(row.status),
    notes: row.notes || "",
    createdAt: row.created_at || ""
  };
}

function phoneToE164(rawValue) {
  let digits = String(rawValue || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = "55" + digits;
  if (!digits.startsWith("55") || (digits.length !== 12 && digits.length !== 13)) {
    throw new Error("Informe um WhatsApp brasileiro com DDD, como +55 11 99999-9999.");
  }
  return "+" + digits;
}

function showToast(message, kind) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast is-visible" + (kind ? " toast-" + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3600);
}

function filteredOrders() {
  let rows = orders.slice();
  const query = searchInput.value.trim().toLocaleLowerCase("pt-BR");
  const status = statusFilter.value;
  if (activeView === "history") rows = rows.filter(order => terminalStatuses.has(order.status));
  if (activeView === "orders") rows = rows.filter(order => !terminalStatuses.has(order.status));
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
  if (query) rows = rows.filter(order => [order.id, order.customer, order.phone, order.items.map(item => item.name).join(" ")].join(" ").toLocaleLowerCase("pt-BR").includes(query));
  return rows.sort((a, b) => (String(a.pickupDate) + a.pickupTime).localeCompare(String(b.pickupDate) + b.pickupTime));
}

function renderRows() {
  const rows = filteredOrders();
  table.innerHTML = rows.map(order => {
    const itemsText = order.items.map(item => Number(item.quantity) + "× " + item.name).join(" · ");
    return "<tr>" +
      "<td><span class=\"order-id\">" + escapeHtml(order.id) + "</span><span class=\"order-date\">" + escapeHtml(prettyDate(order.pickupDate)) + "</span></td>" +
      "<td><div class=\"customer-cell\"><span class=\"customer-avatar\">" + escapeHtml(order.customer.split(/\s+/).slice(0, 2).map(name => name[0] || "").join("").toUpperCase()) + "</span><span><span class=\"customer-name\">" + escapeHtml(order.customer) + "</span><span class=\"customer-phone\">" + escapeHtml(order.phone || "—") + "</span></span></div></td>" +
      "<td><div class=\"items-text\">" + escapeHtml(itemsText || "Itens não informados") + "</div></td>" +
      "<td><span class=\"pickup-time\">" + escapeHtml(order.pickupTime || "A combinar") + "</span><span class=\"pickup-day\">" + escapeHtml(order.pickupLocation || prettyDate(order.pickupDate)) + "</span></td>" +
      "<td><span class=\"status-pill status-" + escapeHtml(order.status) + "\">" + escapeHtml(STATUS[order.status]) + "</span></td>" +
      "<td><button class=\"row-action\" data-order-id=\"" + escapeHtml(order.id) + "\" aria-label=\"Abrir pedido " + escapeHtml(order.id) + "\" type=\"button\">•••</button></td></tr>";
  }).join("");
  document.getElementById("empty-state").hidden = rows.length > 0;
  document.getElementById("result-count").textContent = "Mostrando " + rows.length + (rows.length === 1 ? " pedido" : " pedidos");
  document.getElementById("nav-order-count").textContent = String(orders.length).padStart(2, "0");
  document.getElementById("metric-total").textContent = String(orders.filter(order => !terminalStatuses.has(order.status)).length).padStart(2, "0");
  document.getElementById("metric-pending").textContent = String(orders.filter(order => order.status === "awaiting_confirmation").length).padStart(2, "0");
  document.getElementById("metric-preparing").textContent = String(orders.filter(order => order.status === "preparing").length).padStart(2, "0");
  document.getElementById("metric-ready").textContent = String(orders.filter(order => order.status === "ready").length).padStart(2, "0");
  table.querySelectorAll("[data-order-id]").forEach(button => button.addEventListener("click", () => showOrder(button.dataset.orderId)));
}

function availableActions(order) {
  const actions = {
    awaiting_confirmation: [{ action: "accept", label: "Aceitar pedido" }, { action: "reject", label: "Recusar pedido", danger: true }],
    confirmed: [{ action: "start_preparing", label: "Iniciar preparo" }],
    preparing: [{ action: "mark_ready", label: "Marcar como pronto" }],
    ready: [{ action: "mark_picked_up", label: "Registrar retirada" }]
  };
  return actions[order.status] || [];
}

function showOrder(id) {
  const order = orders.find(item => String(item.id) === String(id));
  if (!order) return;
  const actions = availableActions(order);
  const connected = Boolean(config.orderActionEndpoint) && !usingDemoData;
  const itemList = order.items.map(item => "<li>" + escapeHtml(item.quantity) + "× " + escapeHtml(item.name) + "</li>").join("");
  const actionMarkup = actions.length
    ? "<div class=\"order-actions\"><strong>Atualizar pedido</strong>" +
      (order.status === "awaiting_confirmation" ? "<label class=\"field\"><span>Motivo da recusa (opcional)</span><textarea id=\"reject-reason\" rows=\"2\"></textarea></label>" : "") +
      "<div class=\"dialog-actions\">" + actions.map(action => "<button type=\"button\" class=\"action-button" + (action.danger ? " action-danger" : "") + "\" data-order-action=\"" + action.action + "\"" + (connected ? "" : " disabled") + ">" + action.label + "</button>").join("") + "</div>" +
      (!connected ? "<p class=\"connection-hint\">Ação disponível quando o endpoint autenticado do workflow estiver conectado.</p>" : "") + "</div>"
    : "";
  document.getElementById("dialog-content").innerHTML =
    "<h2 class=\"dialog-title\">" + escapeHtml(order.id) + "</h2>" +
    "<p class=\"dialog-subtitle\">Detalhes da encomenda · " + escapeHtml(prettyDate(order.pickupDate)) + "</p>" +
    "<div class=\"detail-grid\">" +
      "<div><div class=\"detail-label\">Cliente</div><div class=\"detail-value\">" + escapeHtml(order.customer) + "</div></div>" +
      "<div><div class=\"detail-label\">WhatsApp do cliente</div><div class=\"detail-value\">" + escapeHtml(order.phone || "—") + "</div></div>" +
      "<div><div class=\"detail-label\">Retirada</div><div class=\"detail-value\">" + escapeHtml(order.pickupTime || "A combinar") + "</div></div>" +
      "<div><div class=\"detail-label\">Situação</div><div class=\"detail-value\"><span class=\"status-pill status-" + escapeHtml(order.status) + "\">" + escapeHtml(STATUS[order.status]) + "</span></div></div>" +
      "<div><div class=\"detail-label\">Fiscal</div><div class=\"detail-value\">" + escapeHtml(order.fiscalPhone || "—") + "</div></div>" +
      "<div><div class=\"detail-label\">Local de retirada</div><div class=\"detail-value\">" + escapeHtml(order.pickupLocation || "—") + "</div></div>" +
      "<div class=\"detail-items\"><div class=\"detail-label\">Itens</div><ul>" + (itemList || "<li>Itens não informados</li>") + "</ul></div>" +
      "<div class=\"detail-items\"><div class=\"detail-label\">Observações</div><div class=\"detail-value\">" + escapeHtml(order.notes || "Sem observações") + "</div></div></div>" + actionMarkup;
  document.querySelectorAll("[data-order-action]").forEach(button => button.addEventListener("click", () => performOrderAction(order, button.dataset.orderAction)));
  orderDialog.showModal();
}

async function performOrderAction(order, action) {
  const reason = document.getElementById("reject-reason")?.value.trim() || "";
  try {
    await requestJson(config.orderActionEndpoint, { method: "POST", body: JSON.stringify({ external_order_id: order.id, action, reason }) });
    orderDialog.close();
    showToast("Pedido atualizado pelo workflow.", "success");
    await refreshOrders();
  } catch (error) { showToast(error.message || "Não foi possível atualizar o pedido.", "error"); }
}

function selectView(view) {
  activeView = view;
  const titles = { overview: "Visão geral", orders: "Pedidos", history: "Histórico", settings: "Configurações" };
  document.querySelectorAll(".nav-link[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  document.getElementById("breadcrumb-current").textContent = titles[view];
  document.getElementById("page-title").textContent = titles[view];
  document.getElementById("page-subtitle").textContent = {
    overview: "Acompanhe encomendas, produção e retirada.",
    orders: "Acompanhe cada encomenda e atualize a situação na cozinha.",
    history: "Consulte pedidos retirados, recusados e cancelados.",
    settings: "Cadastre os números da padaria, da fiscal e o contato padrão do cliente."
  }[view];
  document.getElementById("orders-section").hidden = view === "settings";
  document.getElementById("metrics").hidden = view === "settings";
  document.getElementById("connection-notice").hidden = view === "settings" || connectionMode === "connected";
  document.getElementById("settings-section").hidden = view !== "settings";
  document.getElementById("list-title").textContent = view === "history" ? "Histórico de pedidos" : view === "orders" ? "Pedidos ativos" : "Pedidos recentes";
  renderRows();
}

async function requestJson(endpoint, options) {
  if (!endpoint) throw new Error("A API segura ainda não está conectada.");
  const token = sessionStorage.getItem(apiTokenStorageKey);
  if (!token) throw new Error("Conecte a dashboard com o token de acesso do n8n.");
  const headers = new Headers(options?.headers || {});
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  headers.set("x-dashboard-token", token);
  const { headers: _ignoredHeaders, ...requestOptions } = options || {};
  const response = await fetch(endpoint, {
    credentials: "omit",
    ...requestOptions,
    headers
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (response.status === 401 || response.status === 403) {
    sessionStorage.removeItem(apiTokenStorageKey);
    setIntegrationStates();
    throw new Error("Token recusado pelo workflow. Verifique o acesso configurado no n8n.");
  }
  if (!response.ok) throw new Error(data?.message || "Falha na API (HTTP " + response.status + ").");
  return data;
}

function updateConnectionUi(mode, message) {
  connectionMode = mode;
  const title = document.getElementById("connection-title");
  const caption = document.getElementById("connection-caption");
  const dot = document.getElementById("connection-dot");
  const badge = document.getElementById("demo-badge");
  const notice = document.getElementById("connection-notice");
  if (mode === "connected") {
    title.textContent = "API conectada";
    caption.textContent = message || "Pedidos sincronizados";
    dot.classList.add("is-online");
    badge.hidden = true;
    notice.hidden = true;
  } else if (mode === "error") {
    title.textContent = "Falha na conexão";
    caption.textContent = message || "Não foi possível carregar pedidos";
    dot.classList.remove("is-online");
    badge.hidden = true;
    notice.hidden = false;
    notice.querySelector("p").innerHTML = "<strong>Não foi possível carregar os pedidos reais.</strong> " + escapeHtml(message || "Verifique a API.");
  } else if (mode === "disconnected") {
    title.textContent = "Painel desconectado";
    caption.textContent = message || "Conecte o acesso do n8n";
    dot.classList.remove("is-online");
    badge.hidden = false;
    badge.textContent = "Sem dados reais";
    notice.hidden = false;
  }
}

async function refreshOrders() {
  const button = document.getElementById("refresh-button");
  button.classList.add("is-refreshing");
  try {
    if (!sessionStorage.getItem(apiTokenStorageKey)) {
      usingDemoData = false;
      orders = [];
      updateConnectionUi("disconnected", "Informe o token de acesso do n8n");
    } else if (!config.ordersEndpoint) {
      usingDemoData = false;
      orders = [];
      updateConnectionUi("disconnected", "Configure a API autenticada do n8n");
    } else {
      usingDemoData = false;
      const payload = await requestJson(config.ordersEndpoint, { method: "GET" });
      const rows = Array.isArray(payload) ? payload : payload?.data || payload?.orders;
      if (!Array.isArray(rows)) throw new Error("A API não retornou uma lista de pedidos.");
      orders = rows.map(normalizeOrder);
      updateConnectionUi("connected", "Pedidos atualizados");
      document.getElementById("last-updated").textContent = "Atualizado " + new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date());
    }
  } catch (error) {
    usingDemoData = false;
    orders = [];
    updateConnectionUi("error", error.message);
  } finally {
    renderRows();
    setIntegrationStates();
    button.classList.remove("is-refreshing");
  }
}

function setIntegrationStates() {
  const hasToken = Boolean(sessionStorage.getItem(apiTokenStorageKey));
  const hasOrders = hasToken && Boolean(config.ordersEndpoint);
  const hasActions = hasToken && Boolean(config.orderActionEndpoint);
  const hasContacts = hasToken && Boolean(config.settingsEndpoint);
  document.getElementById("orders-api-state").textContent = hasOrders ? "Conectando" : "Aguardando acesso";
  document.getElementById("actions-api-state").textContent = hasActions ? "Conectando" : "Aguardando acesso";
  document.getElementById("contacts-api-state").textContent = contactsLoaded ? "Conectado" : hasContacts ? "Aguardando API" : "Aguardando acesso";
  document.getElementById("settings-connection-state").textContent = contactsLoaded ? "Conectado" : hasContacts ? "Aguardando API" : "Aguardando acesso";
  document.querySelector(".settings-save-button").disabled = !hasContacts || !contactsLoaded;
  document.getElementById("new-order-button").disabled = !hasToken || !config.createOrderEndpoint || usingDemoData;
  document.querySelector("#new-order-form button[type='submit']").disabled = !hasToken || !config.createOrderEndpoint || usingDemoData;
  const accessButton = document.getElementById("api-access-button");
  accessButton.textContent = hasToken ? "Desconectar" : "Conectar";
  accessButton.setAttribute("aria-pressed", String(hasToken));
}

function populateSettings(settings) {
  document.getElementById("bakery-phone").value = settings.bakery_phone_e164 || "";
  document.getElementById("fiscal-phone").value = settings.fiscal_phone_e164 || "";
  document.getElementById("customer-phone-setting").value = settings.customer_phone_e164 || "";
  document.getElementById("new-order-fiscal-phone").value = settings.fiscal_phone_e164 || "";
  document.getElementById("new-order-customer-phone").value = settings.customer_phone_e164 || "";
}

async function loadSettings() {
  contactsLoaded = false;
  populateSettings({});
  setIntegrationStates();
  if (!sessionStorage.getItem(apiTokenStorageKey)) {
    document.getElementById("settings-save-status").textContent = "Conecte o painel para carregar os contatos salvos.";
    return false;
  }
  if (!config.settingsEndpoint) {
    document.getElementById("settings-save-status").textContent = "Conexão com a configuração do workflow ainda não está ativa.";
    return false;
  }
  try {
    const payload = await requestJson(config.settingsEndpoint, { method: "GET" });
    populateSettings(payload?.data || payload || {});
    document.getElementById("settings-save-status").textContent = "Contatos carregados do workflow.";
    contactsLoaded = true;
    setIntegrationStates();
    return true;
  } catch (error) {
    document.getElementById("settings-save-status").textContent = "Falha ao carregar contatos: " + error.message;
    setIntegrationStates();
    document.getElementById("settings-connection-state").textContent = "Falha na conexão";
    return false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const status = document.getElementById("settings-save-status");
  const button = document.querySelector(".settings-save-button");
  try {
    const settings = {
      bakery_phone_e164: phoneToE164(document.getElementById("bakery-phone").value),
      fiscal_phone_e164: phoneToE164(document.getElementById("fiscal-phone").value),
      customer_phone_e164: phoneToE164(document.getElementById("customer-phone-setting").value)
    };
    if (!sessionStorage.getItem(apiTokenStorageKey)) throw new Error("Conecte o painel antes de salvar; os números não foram enviados.");
    if (!config.settingsEndpoint) throw new Error("A API autenticada do workflow ainda não está conectada; os números não foram salvos.");
    if (!contactsLoaded) throw new Error("Conecte a API do workflow antes de salvar os números.");
    button.disabled = true;
    await requestJson(config.settingsEndpoint, { method: "PUT", body: JSON.stringify(settings) });
    status.textContent = "Números atualizados no workflow.";
    showToast("Contatos sincronizados.", "success");
    document.getElementById("new-order-fiscal-phone").value = settings.fiscal_phone_e164;
    document.getElementById("new-order-customer-phone").value = settings.customer_phone_e164;
  } catch (error) {
    status.textContent = error.message || "Não foi possível salvar os números.";
    showToast(status.textContent, "error");
  } finally { button.disabled = !config.settingsEndpoint || !sessionStorage.getItem(apiTokenStorageKey) || !contactsLoaded; }
}

function parseItems(rawValue) {
  return String(rawValue || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const match = line.match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s*(.+)$/i);
    if (!match) throw new Error("Use uma linha por produto no formato 2x Nome do produto.");
    return { quantity: Number(match[1].replace(",", ".")), name: match[2].trim() };
  });
}

async function submitNewOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById("new-order-status");
  const formData = new FormData(form);
  try {
    const payload = {
      customer: { name: String(formData.get("customer_name") || "").trim(), phone: phoneToE164(formData.get("customer_phone")) },
      fiscal_phone: phoneToE164(formData.get("fiscal_phone")),
      pickup_date: String(formData.get("pickup_date") || ""),
      pickup_time: String(formData.get("pickup_time") || ""),
      items: parseItems(formData.get("items")),
      notes: String(formData.get("notes") || "").trim()
    };
    await requestJson(config.createOrderEndpoint, { method: "POST", body: JSON.stringify(payload) });
    newOrderDialog.close();
    form.reset();
    showToast("Pedido registrado no workflow.", "success");
    await refreshOrders();
  } catch (error) { status.textContent = error.message || "Não foi possível registrar o pedido."; }
}

function openApiAccess() {
  if (sessionStorage.getItem(apiTokenStorageKey)) {
    sessionStorage.removeItem(apiTokenStorageKey);
    contactsLoaded = false;
    orders = [];
    populateSettings({});
    setIntegrationStates();
    updateConnectionUi("disconnected", "Acesso encerrado nesta sessão");
    document.getElementById("settings-save-status").textContent = "Conecte o painel para carregar os contatos salvos.";
    renderRows();
    return;
  }
  apiTokenInput.value = "";
  document.getElementById("api-access-status").textContent = "";
  apiAccessDialog.showModal();
  apiTokenInput.focus();
}

async function connectApi(event) {
  event.preventDefault();
  const token = apiTokenInput.value.trim();
  const status = document.getElementById("api-access-status");
  if (!token) {
    status.textContent = "Informe o token configurado no webhook protegido do n8n.";
    return;
  }
  sessionStorage.setItem(apiTokenStorageKey, token);
  setIntegrationStates();
  status.textContent = "Conferindo acesso ao workflow…";
  const settingsLoaded = await loadSettings();
  if (!settingsLoaded) {
    sessionStorage.removeItem(apiTokenStorageKey);
    setIntegrationStates();
    status.textContent = "Não conectou. Confira o token e se a API do workflow está ativa.";
    return;
  }
  apiAccessDialog.close();
  status.textContent = "";
  await refreshOrders();
}

document.querySelectorAll(".nav-link[data-view]").forEach(button => button.addEventListener("click", () => selectView(button.dataset.view)));
searchInput.addEventListener("input", renderRows);
statusFilter.addEventListener("change", renderRows);
dateFilter.addEventListener("change", renderRows);
document.getElementById("refresh-button").addEventListener("click", refreshOrders);
document.getElementById("view-all-button").addEventListener("click", () => selectView("orders"));
document.getElementById("clear-filters").addEventListener("click", () => {
  searchInput.value = "";
  statusFilter.value = "all";
  dateFilter.value = "all";
  renderRows();
});
document.getElementById("settings-form").addEventListener("submit", saveSettings);
document.getElementById("api-access-button").addEventListener("click", openApiAccess);
document.getElementById("api-access-form").addEventListener("submit", connectApi);
document.getElementById("new-order-button").addEventListener("click", () => {
  document.getElementById("new-order-status").textContent = "";
  document.getElementById("new-order-fiscal-phone").value = document.getElementById("fiscal-phone").value;
  const customerPhone = document.getElementById("new-order-customer-phone");
  if (!customerPhone.value) customerPhone.value = document.getElementById("customer-phone-setting").value;
  newOrderDialog.showModal();
});
document.getElementById("new-order-form").addEventListener("submit", submitNewOrder);
orderDialog.addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
newOrderDialog.addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
document.getElementById("today-label").textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).format(today);
document.getElementById("footer-year").textContent = String(today.getFullYear());

setIntegrationStates();
populateSettings({});
renderRows();
if (sessionStorage.getItem(apiTokenStorageKey)) {
  loadSettings().then(refreshOrders);
} else {
  updateConnectionUi("disconnected", "Conecte o acesso do n8n para carregar os pedidos");
}
