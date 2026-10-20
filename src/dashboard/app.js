import { STATUS, today, normalizeOrder, phoneToE164, escapeHtml, prettyDate, availableActions } from "./domain/orders.js";
import { createOrderListRenderer } from "./ui/order-list.js";
import { createAgendaView } from "./ui/agenda.js";
import { mountOrderItems } from "../shared/order-items.js";

let agendaDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
let agendaMode = "day";

const config = window.ORDER_DASHBOARD_CONFIG || {};
const apiTokenStorageKey = "order-dashboard-api-token";
const settingsDraftStorageKey = "order-dashboard-settings-draft";
try { localStorage.removeItem(settingsDraftStorageKey); } catch { /* Storage can be disabled by the browser. */ }
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
let dashboardAuthenticated = false;
let contactsLoaded = false;
let toastTimer;
let productionTasks = [];
let itemEditor;
const dashboardItemEditorReady = mountOrderItems(document.getElementById("dashboard-order-items"))
  .then(editor => { itemEditor = editor; })
  .catch(error => { document.getElementById("new-order-status").textContent = error.message; });

const orderList = createOrderListRenderer({
  getOrders: () => orders,
  getActiveView: () => activeView,
  onOpenOrder: showOrder
});
const renderRows = orderList.renderRows;
const agendaView = createAgendaView({
  getOrders: () => orders,
  getAgendaDate: () => agendaDate,
  setAgendaDate: value => { agendaDate = value; },
  getAgendaMode: () => agendaMode,
  setAgendaModeState: value => { agendaMode = value; },
  getSearchQuery: () => searchInput.value,
  getStatusFilter: () => statusFilter.value,
  onOpenOrder: showOrder
});
const renderAgenda = agendaView.renderAgenda;
const setAgendaMode = agendaView.setAgendaMode;
const moveAgenda = agendaView.moveAgenda;

function showToast(message, kind) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "toast is-visible" + (kind ? " toast-" + kind : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3600);
}

function showOrder(id) {
  const order = orders.find(item => String(item.id) === String(id));
  if (!order) return;
  const actions = availableActions(order);
  const connected = Boolean(config.orderActionEndpoint) && !usingDemoData;
  const itemList = order.items.map(item => "<li>" + escapeHtml(item.quantity) + "× " + escapeHtml(item.name) + (item.sector ? " <small>· " + escapeHtml(item.sector) + "</small>" : "") + "</li>").join("");
  const itemsMarkup = itemList ? "<ul>" + itemList + "</ul>" : "<div class=\"detail-value\">" + escapeHtml(order.itemsSummary || "Itens não informados") + "</div>";
  const reasonLabel = order.status === "awaiting_confirmation" ? "Motivo para a fiscal analisar (opcional)" : "";
  const actionMarkup = actions.length
    ? "<div class=\"order-actions\"><strong>Atualizar pedido</strong>" +
      (reasonLabel ? "<label class=\"field\"><span>" + reasonLabel + "</span><textarea id=\"action-reason\" rows=\"2\"></textarea></label>" : "") +
      "<div class=\"dialog-actions\">" + actions.map(action => "<button type=\"button\" class=\"action-button" + (action.danger ? " action-danger" : "") + "\" data-order-action=\"" + action.action + "\"" + (connected ? "" : " disabled") + ">" + action.label + "</button>").join("") + "</div>" +
      (!connected ? "<p class=\"connection-hint\">Ação disponível quando a API autenticada estiver conectada.</p>" : "") + "</div>"
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
      "<div class=\"detail-items\"><div class=\"detail-label\">Itens</div>" + itemsMarkup + "</div>" +
      "<div><div class=\"detail-label\">Setor</div><div class=\"detail-value\">" + escapeHtml(order.sector || "—") + "</div></div>" +
      "<div class=\"detail-items\"><div class=\"detail-label\">Observações</div><div class=\"detail-value\">" + escapeHtml(order.notes || "Sem observações") + "</div></div></div>" + actionMarkup;
  document.querySelectorAll("[data-order-action]").forEach(button => button.addEventListener("click", () => performOrderAction(order, button.dataset.orderAction)));
  orderDialog.showModal();
}

async function performOrderAction(order, action) {
  const reason = document.getElementById("action-reason")?.value.trim() || "";
  if (action === "reject" && !window.confirm("A fiscal já avisou o cliente que não será possível atender este pedido? Só encerre depois desse contato.")) return;
  try {
    await requestJson(config.orderActionEndpoint, { method: "POST", body: JSON.stringify({
      event_id: crypto.randomUUID(),
      external_order_id: order.id,
      customer_phone: order.phone,
      action,
      reason,
      sector: order.sector,
      ...(action === "reject" ? { customer_informed: true } : {})
    }) });
    orderDialog.close();
    showToast(action === "request_review" ? "Fiscal avisada; o pedido continua pendente." : "Pedido atualizado.", "success");
    await refreshOrders();
  } catch (error) { showToast(error.message || "Não foi possível atualizar o pedido.", "error"); }
}

function selectView(view) {
  activeView = view;
  const titles = { overview: "Visão geral", orders: "Pedidos", agenda: "Agenda da produção", history: "Histórico", settings: "Configurações" };
  document.querySelectorAll(".nav-link[data-view]").forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.getElementById("breadcrumb-current").textContent = titles[view];
  document.getElementById("page-title").textContent = titles[view];
  document.getElementById("page-subtitle").textContent = {
    overview: "Acompanhe encomendas, produção e retirada.",
    orders: "Acompanhe cada encomenda e atualize a situação na cozinha.",
    agenda: "Consulte os pedidos aceitos e atualize o andamento dos itens por setor.",
    history: "Consulte pedidos retirados, recusados e cancelados.",
    settings: "Gerencie os WhatsApps da padaria, fiscal, Açougue e Frios."
  }[view];
  document.getElementById("orders-section").hidden = view === "settings" || view === "agenda";
  document.getElementById("agenda-section").hidden = view !== "agenda";
  document.getElementById("metrics").hidden = view === "settings";
  document.getElementById("connection-notice").hidden = view === "settings" || connectionMode === "connected";
  document.getElementById("settings-section").hidden = view !== "settings";
  document.getElementById("list-title").textContent = view === "history" ? "Histórico de pedidos" : view === "orders" ? "Pedidos ativos" : "Pedidos recentes";
  renderRows();
  renderAgenda();
}

async function requestJson(endpoint, options) {
  if (!endpoint) throw new Error("A API segura ainda não está conectada.");
  if (!dashboardAuthenticated) throw new Error("Entre na dashboard para acessar os dados da operação.");
  const headers = new Headers(options?.headers || {});
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const { headers: _ignoredHeaders, ...requestOptions } = options || {};
  const response = await fetch(endpoint, {
    credentials: "same-origin",
    cache: "no-store",
    ...requestOptions,
    headers
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : null;
  if (response.status === 401 || response.status === 403) {
    dashboardAuthenticated = false;
    setIntegrationStates();
    throw new Error("Sua sessão terminou. Entre novamente para continuar.");
  }
  if (!response.ok) {
    const upstreamMessage = typeof data?.message === "string" ? data.message : "";
    if (response.status === 502) {
      throw new Error(upstreamMessage || "A API não conseguiu completar a chamada ao Supabase ou à Z-API (HTTP 502).");
    }
    throw new Error(upstreamMessage || "Falha na API (HTTP " + response.status + ").");
  }
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
    caption.textContent = message || "Conecte o acesso da API";
    dot.classList.remove("is-online");
    badge.hidden = false;
    badge.innerHTML = '<span class="demo-dot" aria-hidden="true"></span>Acesso necessário';
    notice.hidden = false;
  }
}

async function refreshOrders() {
  const button = document.getElementById("refresh-button");
  button.classList.add("is-refreshing");
  try {
    if (!dashboardAuthenticated) {
      usingDemoData = false;
      orders = [];
      updateConnectionUi("disconnected", "Entre para acessar os pedidos");
    } else if (!config.ordersEndpoint) {
      usingDemoData = false;
      orders = [];
      updateConnectionUi("disconnected", "A API ainda não está configurada");
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
    renderAgenda();
    setIntegrationStates();
    button.classList.remove("is-refreshing");
  }
  await refreshProductionAgenda(true);
}

function productionState(task) {
  const status = String(task?.status || "").toLowerCase();
  if (/complete|ready|done/.test(status)) return "completed";
  if (/attention|issue|blocked|problem/.test(status)) return "needs_attention";
  if (/progress|prepar|started|working/.test(status)) return "in_progress";
  return "planned";
}

function relation(value) { return Array.isArray(value) ? value[0] || {} : value || {}; }

function departmentForTask(task) {
  const sector = relation(task.sector);
  const label = [sector.slug, sector.name || task.sector_name].filter(Boolean).join(" ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  if (/acougue|butcher/.test(label)) return "Açougue";
  if (/frios|cold.?cuts/.test(label)) return "Frios";
  return "Padaria";
}

function productionTaskItems(task) {
  const items = Array.isArray(task.items) ? task.items : [];
  return items.map(item => {
    if (typeof item === "string") return escapeHtml(item);
    const name = item.name || item.product_name || relation(item.product).name || "Produto";
    return escapeHtml(item.quantity || 1) + "× " + escapeHtml(name);
  });
}

function renderProductionBoard(message) {
  const board = document.getElementById("production-board");
  if (message) {
    board.innerHTML = "<div class=\"agenda-empty\"><strong>" + escapeHtml(message) + "</strong></div>";
    return;
  }
  const departments = new Map();
  for (const task of productionTasks) {
    const order = relation(task.order);
    const orderKey = String(task.order_id || order.id || order.external_order_id || "pedido");
    const department = departmentForTask(task);
    if (!departments.has(department)) departments.set(department, new Map());
    const departmentOrders = departments.get(department);
    if (!departmentOrders.has(orderKey)) departmentOrders.set(orderKey, { name: department, tasks: [] });
    departmentOrders.get(orderKey).tasks.push(task);
  }
  if (!departments.size) {
    board.innerHTML = "<div class=\"agenda-empty\"><strong>Nenhum item na produção</strong><span>Os setores recebem os itens quando a padaria confirma o pedido.</span></div>";
    return;
  }
  const statusLabel = { planned: "Aguardando início", in_progress: "Em produção", needs_attention: "Atenção", completed: "Concluído" };
  const departmentOrder = ["Padaria", "Açougue", "Frios"];
  board.innerHTML = Array.from(departments.entries()).sort(([a], [b]) => departmentOrder.indexOf(a) - departmentOrder.indexOf(b)).map(([departmentName, departmentOrders]) => {
    const group = { name: departmentName, tasks: Array.from(departmentOrders.values()) };
    const cards = group.tasks.sort((a, b) => String(relation(a.tasks[0].order).requested_date || "").localeCompare(String(relation(b.tasks[0].order).requested_date || "")) || String(relation(a.tasks[0].order).requested_time || "").localeCompare(String(relation(b.tasks[0].order).requested_time || ""))).map(orderGroup => {
      const tasks = orderGroup.tasks;
      const primaryTask = tasks[0];
      const order = relation(primaryTask.order);
      const customer = relation(order.customer);
      const reference = String(order.display_id || order.external_order_id || order.id || "Pedido");
      const states = tasks.map(productionState);
      const state = states.every(value => value === "completed")
        ? "completed"
        : states.includes("needs_attention")
          ? "needs_attention"
          : states.includes("planned")
            ? "planned"
            : "in_progress";
      const items = tasks.map(task => {
        const sector = relation(task.sector);
        const name = sector.name || task.sector_name || "Setor";
        return "<div class=\"production-task-area\"><span class=\"production-subsector\">" + escapeHtml(name) + "</span><br>" + (productionTaskItems(task).join("<br>") || "Itens não informados") + "</div>";
      }).join("");
      const taskIds = tasks.map(task => String(task.id || "")).filter(Boolean);
      const buttons = state === "completed"
        ? ""
        : (state === "planned" || state === "needs_attention" ? "<button type=\"button\" class=\"action-button\" data-production-action=\"start_preparing\">" + (state === "planned" ? "Iniciar setor" : "Retomar produção") + "</button>" : "<button type=\"button\" class=\"action-button\" data-production-action=\"mark_ready\">Marcar setor pronto</button>") +
          "<button type=\"button\" class=\"action-button action-danger\" data-production-action=\"report_issue\">Reportar problema</button>";
      return "<article class=\"production-task\" data-order-ref=\"" + escapeHtml(order.external_order_id || order.id || "") + "\" data-task-ids=\"" + escapeHtml(JSON.stringify(taskIds)) + "\" data-department=\"" + escapeHtml(group.name) + "\" data-customer-phone=\"" + escapeHtml(customer.phone_e164 || "") + "\" data-task-status=\"" + state + "\"><div class=\"production-task-top\"><div><strong>" + escapeHtml(reference) + "</strong><span>" + escapeHtml(customer.name || "Cliente") + "</span></div><span class=\"production-status production-status-" + state + "\">" + statusLabel[state] + "</span></div><p class=\"production-task-due\">Retirada: " + escapeHtml([order.requested_date, order.requested_time].filter(Boolean).join(" às ") || "A combinar") + "</p><div class=\"production-task-items\">" + items + "</div>" + (buttons ? "<div class=\"production-task-actions\">" + buttons + "</div>" : "") + "</article>";
    }).join("");
    return "<section class=\"production-sector\"><h4>" + escapeHtml(group.name) + "<span>" + group.tasks.length + (group.tasks.length === 1 ? " pedido" : " pedidos") + "</span></h4><div class=\"production-sector-tasks\">" + cards + "</div></section>";
  }).join("");
  board.querySelectorAll("[data-production-action]").forEach(button => button.addEventListener("click", () => performProductionAction(button)));
}

async function refreshProductionAgenda(silent = false) {
  if (!dashboardAuthenticated || !config.productionAgendaEndpoint) {
    productionTasks = [];
    renderProductionBoard("Entre na operação para carregar o andamento");
    return;
  }
  try {
    const payload = await requestJson(config.productionAgendaEndpoint, { method: "GET" });
    productionTasks = Array.isArray(payload?.data) ? payload.data : [];
    renderProductionBoard();
  } catch (error) {
    productionTasks = [];
    renderProductionBoard("Não foi possível carregar a produção: " + error.message);
    if (!silent) showToast(error.message || "Não foi possível carregar a produção.", "error");
  }
}

async function performProductionAction(button) {
  const card = button.closest(".production-task");
  const action = button.dataset.productionAction;
  const orderRef = card.dataset.orderRef;
  const taskIds = JSON.parse(card.dataset.taskIds || "[]");
  const tasks = productionTasks.filter(task => taskIds.includes(String(task.id || "")));
  const issueTask = tasks.find(task => productionState(task) !== "completed");
  let reason = "";
  if (action === "report_issue") {
    const issueSector = relation(issueTask?.sector);
    reason = window.prompt("Descreva o problema em " + (issueSector.name || issueTask?.sector_name || card.dataset.department) + " para a fiscal:")?.trim() || "";
    if (!reason) return;
  }
  const actionTasks = action === "report_issue"
    ? (issueTask ? [issueTask] : [])
    : tasks.filter(task => productionState(task) !== "completed" && (action !== "start_preparing" || productionState(task) !== "in_progress"));
  const hasStartedBefore = productionTasks.some(task => {
    const order = relation(task.order);
    return String(order.external_order_id || order.id || "") === orderRef && ["in_progress", "completed"].includes(productionState(task));
  });
  if (!actionTasks.length) return;
  button.disabled = true;
  let completedActions = 0;
  let warnings = [];
  try {
    for (const task of actionTasks) {
      const sector = relation(task.sector);
      const result = await requestJson(config.orderActionEndpoint, { method: "POST", body: JSON.stringify({
        event_id: crypto.randomUUID(), external_order_id: orderRef,
        customer_phone: card.dataset.customerPhone,
        action, sector: sector.name || task.sector_name || card.dataset.department,
        sector_id: task.sector_id || sector.id,
        notify_customer: action === "start_preparing" && !hasStartedBefore && completedActions === 0,
        reason
      }) });
      completedActions++;
      warnings = warnings.concat(result?.warnings || []);
    }
    showToast(warnings.length ? "Andamento atualizado; há um aviso WhatsApp pendente." : "Andamento do setor atualizado.", warnings.length ? "error" : "success");
    await refreshOrders();
  } catch (error) {
    await refreshOrders();
    showToast(completedActions ? "Atualização parcial do setor. " + error.message : error.message || "Não foi possível atualizar o setor.", "error");
  }
}

function setIntegrationStates() {
  const hasAccess = dashboardAuthenticated;
  const hasOrders = hasAccess && Boolean(config.ordersEndpoint);
  const hasActions = hasAccess && Boolean(config.orderActionEndpoint);
  const hasContacts = hasAccess && Boolean(config.settingsEndpoint);
  setIntegrationPill("orders-api-state", connectionMode === "connected" ? "Conectado" : connectionMode === "error" && hasOrders ? "Falha" : hasOrders ? "Aguardando API" : "Aguardando acesso");
  setIntegrationPill("actions-api-state", connectionMode === "connected"
    ? "Rota preparada"
    : connectionMode === "error" && hasActions
      ? "Falha na conexão"
      : hasActions
        ? "Aguardando API"
        : "Aguardando acesso");
  setIntegrationPill("contacts-api-state", contactsLoaded ? "Conectado" : hasContacts ? "Aguardando API" : "Aguardando acesso");
  setIntegrationPill("settings-connection-state", contactsLoaded ? "Conectado" : hasContacts ? "Aguardando API" : "Aguardando acesso");
  document.querySelector(".settings-save-button").disabled = false;
  const canCreateOrders = hasAccess && Boolean(config.createOrderEndpoint) && connectionMode === "connected" && !usingDemoData;
  document.getElementById("new-order-button").disabled = !canCreateOrders;
  document.querySelector("#new-order-form button[type='submit']").disabled = !canCreateOrders;
  const accessButton = document.getElementById("api-access-button");
  accessButton.textContent = hasAccess ? "Sair" : "Acessar";
  accessButton.setAttribute("aria-pressed", String(hasAccess));
  accessButton.title = hasAccess ? "Encerrar sessão segura" : "Entrar na operação";
}

function setIntegrationPill(id, label) {
  const element = document.getElementById(id);
  element.textContent = label;
  element.classList.remove("status-demo", "status-ready", "status-needs_attention");
  if (label === "Conectado" || label === "Rota preparada") element.classList.add("status-ready");
  else if (label.startsWith("Falha")) element.classList.add("status-needs_attention");
  else element.classList.add("status-demo");
}

function phoneInputValue(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) return digits.slice(2);
  return String(value || "");
}

function populateSettings(settings) {
  document.getElementById("bakery-phone").value = phoneInputValue(settings.bakery_phone_e164);
  document.getElementById("fiscal-phone").value = phoneInputValue(settings.fiscal_phone_e164);
  document.getElementById("customer-phone-setting").value = phoneInputValue(settings.customer_phone_e164);
  document.getElementById("butcher-phone").value = phoneInputValue(settings.butcher_phone_e164);
  document.getElementById("cold-cuts-phone").value = phoneInputValue(settings.cold_cuts_phone_e164);
  document.getElementById("new-order-fiscal-phone").value = settings.fiscal_phone_e164 || "";
}

function readSettingsDraft() {
  try {
    const value = JSON.parse(sessionStorage.getItem(settingsDraftStorageKey) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      bakery_phone_e164: String(value.bakery_phone_e164 || ""),
      fiscal_phone_e164: String(value.fiscal_phone_e164 || ""),
      customer_phone_e164: String(value.customer_phone_e164 || ""),
      butcher_phone_e164: String(value.butcher_phone_e164 || ""),
      cold_cuts_phone_e164: String(value.cold_cuts_phone_e164 || "")
    };
  } catch {
    return null;
  }
}

function storeSettingsDraft(settings) {
  sessionStorage.setItem(settingsDraftStorageKey, JSON.stringify(settings));
}

function saveSettingsDraftFromInputs() {
  const settings = {
    bakery_phone_e164: document.getElementById("bakery-phone").value.trim(),
    fiscal_phone_e164: document.getElementById("fiscal-phone").value.trim(),
    customer_phone_e164: document.getElementById("customer-phone-setting").value.trim(),
    butcher_phone_e164: document.getElementById("butcher-phone").value.trim(),
    cold_cuts_phone_e164: document.getElementById("cold-cuts-phone").value.trim()
  };
  if (Object.values(settings).some(Boolean)) storeSettingsDraft(settings);
  else sessionStorage.removeItem(settingsDraftStorageKey);
}

function normalizeSettingsResponse(payload) {
  const result = payload?.data ?? payload?.settings ?? payload;
  const settings = Array.isArray(result)
    ? result.find(row => row?.setting_key === "operation") || result[0] || {}
    : result;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("A API não retornou a configuração dos contatos.");
  }
  const hasContactFields = "bakery_phone_e164" in settings || "fiscal_phone_e164" in settings || "customer_phone_e164" in settings || "butcher_phone_e164" in settings || "cold_cuts_phone_e164" in settings || "setting_key" in settings;
  if (Object.keys(settings).length > 0 && !hasContactFields) {
    throw new Error("A API respondeu sem os contatos de operação.");
  }
  return settings;
}

async function loadSettings() {
  const pendingDraft = readSettingsDraft();
  contactsLoaded = false;
  populateSettings(pendingDraft || {});
  setIntegrationStates();
  if (!dashboardAuthenticated) {
    document.getElementById("settings-save-status").textContent = pendingDraft
      ? "Rascunho guardado neste navegador. Entre e salve para sincronizar com a operação."
      : "Entre na operação para carregar ou atualizar os contatos salvos.";
    return false;
  }
  if (!config.settingsEndpoint) {
      document.getElementById("settings-save-status").textContent = pendingDraft
      ? "Rascunho guardado neste navegador. A API ainda não está configurada."
      : "Conexão com a configuração da operação ainda não está ativa.";
    return false;
  }
  try {
    const payload = await requestJson(config.settingsEndpoint, { method: "GET" });
    const settings = normalizeSettingsResponse(payload);
    populateSettings(pendingDraft || settings);
    document.getElementById("settings-save-status").textContent = pendingDraft
      ? "Números deste navegador aguardando sincronização. Clique em Salvar alterações."
      : settings.bakery_phone_e164 || settings.fiscal_phone_e164 || settings.customer_phone_e164 || settings.butcher_phone_e164 || settings.cold_cuts_phone_e164
        ? "Contatos carregados da API."
        : "Conectado. Cadastre os números da operação.";
    contactsLoaded = true;
    setIntegrationStates();
    return true;
  } catch (error) {
    document.getElementById("settings-save-status").textContent = "Falha ao carregar contatos: " + error.message;
    setIntegrationStates();
    setIntegrationPill("settings-connection-state", "Falha na conexão");
    return false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const status = document.getElementById("settings-save-status");
  const button = document.querySelector(".settings-save-button");
  let settings;
  try {
    settings = {
      bakery_phone_e164: optionalPhone("bakery-phone"),
      fiscal_phone_e164: optionalPhone("fiscal-phone"),
      customer_phone_e164: optionalPhone("customer-phone-setting"),
      butcher_phone_e164: optionalPhone("butcher-phone"),
      cold_cuts_phone_e164: optionalPhone("cold-cuts-phone")
    };
    if (!dashboardAuthenticated || !config.settingsEndpoint || !contactsLoaded) {
      storeSettingsDraft(settings);
      status.textContent = "Números guardados neste navegador. Conecte a API e clique em Salvar alterações para sincronizar.";
      showToast("Números guardados neste navegador.", "success");
      return;
    }
    button.disabled = true;
    await requestJson(config.settingsEndpoint, { method: "PUT", body: JSON.stringify(settings) });
    sessionStorage.removeItem(settingsDraftStorageKey);
    status.textContent = "Números atualizados na operação.";
    showToast("Contatos sincronizados.", "success");
    document.getElementById("new-order-fiscal-phone").value = settings.fiscal_phone_e164;
    document.getElementById("new-order-customer-phone").value = settings.customer_phone_e164;
  } catch (error) {
    if (settings) storeSettingsDraft(settings);
    status.textContent = error.message || "Não foi possível salvar os números.";
    showToast(status.textContent, "error");
  } finally { button.disabled = false; }
}

function optionalPhone(id) {
  const rawValue = document.getElementById(id).value.trim();
  return optionalPhoneValue(rawValue);
}

function optionalPhoneValue(value) {
  const rawValue = String(value || "").trim();
  return rawValue ? phoneToE164(rawValue) : "";
}

async function submitNewOrder(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById("new-order-status");
  const formData = new FormData(form);
  try {
    await dashboardItemEditorReady;
    if (!itemEditor) throw new Error("Não foi possível carregar os setores de produção.");
    const orderRef = "ENC-" + crypto.randomUUID().toUpperCase();
    const payload = {
      event_id: crypto.randomUUID(),
      event_type: "order.created",
      order_ref: orderRef,
      payload: {
        order: {
          id: orderRef,
          requested_date: String(formData.get("pickup_date") || ""),
          requested_time: String(formData.get("pickup_time") || ""),
          pickup_location: String(formData.get("pickup_location") || "").trim(),
          fulfillment_type: "pickup",
          notes: String(formData.get("notes") || "").trim()
        },
        customer: {
          name: String(formData.get("customer_name") || "").trim(),
          phone_e164: phoneToE164(formData.get("customer_phone"))
        },
        fiscal: { phone_e164: optionalPhoneValue(formData.get("fiscal_phone")) },
        items: itemEditor.getItems()
      }
    };
    await requestJson(config.createOrderEndpoint, { method: "POST", body: JSON.stringify(payload) });
    newOrderDialog.close();
    form.reset();
    itemEditor.reset();
    showToast("Pedido registrado.", "success");
    await refreshOrders();
  } catch (error) { status.textContent = error.message || "Não foi possível registrar o pedido."; }
}

async function openApiAccess() {
  if (dashboardAuthenticated) {
    try {
      const response = await fetch(config.authEndpoint || "/api/auth/session", {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Accept": "application/json", "Content-Type": "application/json" }
      });
      if (!response.ok) throw new Error("Não foi possível encerrar a sessão no servidor.");
    } catch (error) {
      showToast(error.message || "Não foi possível encerrar a sessão.", "error");
      return;
    }
    dashboardAuthenticated = false;
    contactsLoaded = false;
    orders = [];
    populateSettings({});
    setIntegrationStates();
    updateConnectionUi("disconnected", "Sessão encerrada com segurança");
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
  apiTokenInput.value = "";
  const status = document.getElementById("api-access-status");
  if (!token) {
    status.textContent = "Informe a credencial da operação.";
    return;
  }
  const submit = document.querySelector("#api-access-form button[type='submit']");
  submit.disabled = true;
  status.textContent = "Iniciando sessão segura…";
  try {
    const response = await fetch(config.authEndpoint || "/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "Não foi possível iniciar a sessão.");
    dashboardAuthenticated = true;
    apiAccessDialog.close();
    status.textContent = "";
    setIntegrationStates();
    await Promise.all([loadSettings(), refreshOrders()]);
  } catch (error) {
    status.textContent = error.message || "Não foi possível validar a credencial.";
  } finally {
    submit.disabled = false;
  }
}

async function bootstrapDashboard() {
  const legacyToken = sessionStorage.getItem(apiTokenStorageKey);
  sessionStorage.removeItem(apiTokenStorageKey);
  try {
    const response = await fetch(config.authEndpoint || "/api/auth/session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    const session = await response.json().catch(() => ({}));
    dashboardAuthenticated = session.authenticated === true;
    if (!dashboardAuthenticated && legacyToken) {
      const migrated = await fetch(config.authEndpoint || "/api/auth/session", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ token: legacyToken })
      });
      const result = await migrated.json().catch(() => ({}));
      dashboardAuthenticated = migrated.ok && result.authenticated === true;
    }
    if (dashboardAuthenticated) {
      setIntegrationStates();
      await Promise.all([loadSettings(), refreshOrders()]);
      return;
    }
    updateConnectionUi("disconnected", "Entre uma vez para conectar este navegador");
    await loadSettings();
  } catch (error) {
    dashboardAuthenticated = false;
    updateConnectionUi("error", error.message || "Não foi possível conectar ao servidor.");
  } finally {
    setIntegrationStates();
  }
}

document.querySelectorAll(".nav-link[data-view]").forEach(button => button.addEventListener("click", () => selectView(button.dataset.view)));
document.getElementById("settings-shortcut").addEventListener("click", () => selectView("settings"));
searchInput.addEventListener("input", renderRows);
searchInput.addEventListener("input", renderAgenda);
statusFilter.addEventListener("change", renderRows);
statusFilter.addEventListener("change", renderAgenda);
dateFilter.addEventListener("change", renderRows);
document.getElementById("refresh-button").addEventListener("click", refreshOrders);
document.getElementById("view-all-button").addEventListener("click", () => selectView("orders"));
document.getElementById("clear-filters").addEventListener("click", () => {
  searchInput.value = "";
  statusFilter.value = "all";
  dateFilter.value = "all";
  renderRows();
  renderAgenda();
});
document.getElementById("settings-form").addEventListener("submit", saveSettings);
document.getElementById("bakery-phone").addEventListener("input", saveSettingsDraftFromInputs);
document.getElementById("fiscal-phone").addEventListener("input", saveSettingsDraftFromInputs);
document.getElementById("customer-phone-setting").addEventListener("input", saveSettingsDraftFromInputs);
document.getElementById("butcher-phone").addEventListener("input", saveSettingsDraftFromInputs);
document.getElementById("cold-cuts-phone").addEventListener("input", saveSettingsDraftFromInputs);
document.getElementById("api-access-button").addEventListener("click", openApiAccess);
document.getElementById("api-access-form").addEventListener("submit", connectApi);
document.getElementById("new-order-button").addEventListener("click", () => {
  document.getElementById("new-order-status").textContent = "";
  document.getElementById("new-order-fiscal-phone").value = document.getElementById("fiscal-phone").value;
  if (!document.getElementById("new-order-customer-phone").value) {
    document.getElementById("new-order-customer-phone").value = document.getElementById("customer-phone-setting").value;
  }
  newOrderDialog.showModal();
});
document.getElementById("new-order-form").addEventListener("submit", submitNewOrder);
document.getElementById("refresh-production").addEventListener("click", () => refreshProductionAgenda());
document.querySelectorAll("[data-agenda-mode]").forEach(button => button.addEventListener("click", () => setAgendaMode(button.dataset.agendaMode)));
document.getElementById("agenda-previous").addEventListener("click", () => moveAgenda(-1));
document.getElementById("agenda-next").addEventListener("click", () => moveAgenda(1));
document.getElementById("agenda-today").addEventListener("click", () => {
  agendaDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  renderAgenda();
});
orderDialog.addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
newOrderDialog.addEventListener("click", event => { if (event.target === event.currentTarget) event.currentTarget.close(); });
document.getElementById("today-label").textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).format(today);
document.getElementById("footer-year").textContent = String(today.getFullYear());

setIntegrationStates();
populateSettings(readSettingsDraft() || {});
renderRows();
renderAgenda();
updateConnectionUi("disconnected", "Conectando automaticamente…");
bootstrapDashboard();
