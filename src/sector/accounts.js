const notice = document.querySelector("#accounts-notice");
const accessRequired = document.querySelector("#access-required");
const content = document.querySelector("#accounts-content");
const form = document.querySelector("#account-form");
const formMessage = document.querySelector("#account-form-message");
const rows = document.querySelector("#accounts-rows");
const empty = document.querySelector("#accounts-empty");
const sectorSelect = document.querySelector("#account-sector");
const roleSelect = document.querySelector("#account-role");
const orderForm = document.querySelector("#order-form");
const itemRows = document.querySelector("#order-item-rows");
const portalOrderRows = document.querySelector("#portal-orders-rows");
const portalOrdersEmpty = document.querySelector("#portal-orders-empty");

let sectors = [];
let requestBusy = false;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function showNotice(message, type = "info") {
  notice.textContent = message;
  notice.className = `notice notice-${type}`;
  notice.hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || "A solicitação não foi concluída."), { status: response.status });
  return data;
}

function roleChanged() {
  const isSector = roleSelect.value === "sector";
  document.querySelector("#sector-field").hidden = !isSector;
  sectorSelect.required = isSector;
}

function renderAccounts(accounts) {
  empty.hidden = accounts.length > 0;
  rows.innerHTML = accounts.map(account => `<tr>
    <td><strong>${esc(account.display_name)}</strong><small>${esc(account.email)}</small></td>
    <td>${account.role === "fiscal" ? "Fiscal" : account.role === "manager" ? "Gerência" : "Setor"}</td>
    <td>${esc(account.sector_name)}</td>
    <td><span class="account-state ${account.active ? "is-active" : "is-paused"}">${account.active ? "Ativa" : "Suspensa"}</span></td>
    <td><button class="button button-secondary account-toggle" data-id="${esc(account.id)}" data-active="${!account.active}">${account.active ? "Suspender" : "Reativar"}</button></td>
  </tr>`).join("");
}

function orderStatusLabel(status) {
  return ({
    awaiting_confirmation: "Aguardando confirmação",
    confirmed: "Confirmado",
    preparing: "Em produção",
    ready: "Pronto para retirada",
    cancelled: "Encerrado"
  })[status] || "Em andamento";
}

async function loadPortalOrders() {
  const button = document.querySelector("#reload-orders");
  button.disabled = true;
  try {
    const data = await api("/api/sector/orders");
    const orders = data.orders || [];
    portalOrdersEmpty.hidden = orders.length > 0;
    portalOrderRows.innerHTML = orders.map(order => {
      const date = String(order.requested_date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const pickup = [date ? `${date[3]}/${date[2]}/${date[1]}` : order.requested_date, String(order.requested_time || "").slice(0, 5)].filter(Boolean).join(" · ");
      return `<tr><td><strong>${esc(order.display_id)}</strong></td><td>${esc(order.customer_name)}</td><td>${esc(pickup || "A confirmar")}</td><td>${esc(orderStatusLabel(order.status))}</td></tr>`;
    }).join("");
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function addOrderItemRow() {
  if (!sectors.length || itemRows.childElementCount >= 100) return;
  const row = document.createElement("div");
  row.className = "order-item-row";
  row.innerHTML = `<label>Produto<input data-field="name" required maxlength="160" placeholder="Ex.: pão de queijo"></label>
    <label>Quantidade<input data-field="quantity" type="number" required min="0.001" max="100000" step="0.001" value="1"></label>
    <label>Tamanho ou detalhe<input data-field="size_label" maxlength="120" placeholder="Opcional"></label>
    <label>Setor<select data-field="sector_id" required>${sectors.map(sector => `<option value="${esc(sector.id)}">${esc(sector.name)}</option>`).join("")}</select></label>
    <button class="button button-quiet remove-item" type="button" aria-label="Remover item">Remover</button>`;
  itemRows.append(row);
  document.querySelector("#add-order-item").disabled = itemRows.childElementCount >= 100;
  row.querySelector("[data-field=name]").focus();
}

function collectItems() {
  return Array.from(itemRows.querySelectorAll(".order-item-row"), row => ({
    name: row.querySelector('[data-field="name"]').value.trim(),
    quantity: Number(row.querySelector('[data-field="quantity"]').value),
    size_label: row.querySelector('[data-field="size_label"]').value.trim(),
    sector_id: row.querySelector('[data-field="sector_id"]').value
  }));
}

async function loadAccounts() {
  document.querySelector("#reload-accounts").disabled = true;
  try {
    const data = await api("/api/sector/accounts");
    sectors = data.sectors || [];
    sectorSelect.innerHTML = `<option value="">Selecione um setor</option>` + sectors.map(sector => `<option value="${esc(sector.id)}">${esc(sector.name)}</option>`).join("");
    renderAccounts(data.accounts || []);
    if (!itemRows.childElementCount) addOrderItemRow();
    showNotice("");
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    document.querySelector("#reload-accounts").disabled = false;
  }
}

function showManager(account) {
  accessRequired.hidden = true;
  content.hidden = false;
  document.querySelector("#manager-name").textContent = `Gerência: ${account.display_name}`;
}

async function init() {
  try {
    const session = await api("/api/sector/session");
    if (session.authenticated && session.account.role === "manager" && !session.account.must_change_password) {
      showManager(session.account);
      await Promise.all([loadAccounts(), loadPortalOrders()]);
      return;
    }
    accessRequired.hidden = false;
    if (session.authenticated) document.querySelector("#manager-login-message").textContent = "Esta conta não tem permissão de gerência no portal.";
  } catch (error) {
    accessRequired.hidden = false;
    showNotice(error.message, "error");
  }
}

document.querySelector("#manager-login-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (requestBusy) return;
  requestBusy = true;
  const button = document.querySelector("#manager-login-button");
  const message = document.querySelector("#manager-login-message");
  button.disabled = true;
  message.textContent = "Entrando…";
  try {
    const result = await api("/api/sector/session", {
      method: "POST",
      body: JSON.stringify({ email: document.querySelector("#manager-email").value.trim(), password: document.querySelector("#manager-password").value })
    });
    if (result.account.role !== "manager" || result.account.must_change_password) {
      await api("/api/sector/session", { method: "DELETE" });
      throw new Error("Esta página exige uma conta de gerência ativa do portal.");
    }
    document.querySelector("#manager-login-form").reset();
    message.textContent = "";
    showManager(result.account);
    await Promise.all([loadAccounts(), loadPortalOrders()]);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    requestBusy = false;
    button.disabled = false;
  }
});

document.querySelector("#manager-logout").addEventListener("click", async () => {
  try { await api("/api/sector/session", { method: "DELETE" }); } catch { /* A sessão local desaparece quando o navegador é fechado. */ }
  content.hidden = true;
  accessRequired.hidden = false;
  showNotice("Sessão da gerência encerrada.");
});

roleSelect.addEventListener("change", roleChanged);
roleChanged();

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (requestBusy) return;
  const payload = Object.fromEntries(new FormData(form).entries());
  requestBusy = true;
  document.querySelector("#create-account-button").disabled = true;
  formMessage.textContent = "Criando conta…";
  try {
    await api("/api/sector/accounts", { method: "POST", body: JSON.stringify(payload) });
    form.reset();
    roleChanged();
    formMessage.textContent = "Conta criada. Entregue a senha inicial por um canal seguro; ela será trocada no primeiro acesso.";
    await loadAccounts();
  } catch (error) {
    formMessage.textContent = error.message;
  } finally {
    requestBusy = false;
    document.querySelector("#create-account-button").disabled = false;
  }
});

document.querySelector("#add-order-item").addEventListener("click", addOrderItemRow);
itemRows.addEventListener("click", event => {
  const button = event.target.closest(".remove-item");
  if (!button) return;
  const row = button.closest(".order-item-row");
  if (itemRows.childElementCount > 1) row.remove();
  else row.querySelectorAll("input").forEach(input => { input.value = input.dataset.field === "quantity" ? "1" : ""; });
  document.querySelector("#add-order-item").disabled = false;
});

orderForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (requestBusy) return;
  const button = document.querySelector("#create-order-button");
  const message = document.querySelector("#order-form-message");
  const values = Object.fromEntries(new FormData(orderForm).entries());
  const order = {
    customer_name: values.customer_name,
    customer_phone: values.customer_phone,
    requested_date: values.requested_date,
    requested_time: values.requested_time,
    pickup_location: values.pickup_location
  };
  const items = collectItems();
  const eventKey = "sector-portal-create-order-event";
  const snapshot = JSON.stringify({ order, items });
  let savedEvent = null;
  try { savedEvent = JSON.parse(sessionStorage.getItem(eventKey) || "null"); } catch { savedEvent = null; }
  if (!savedEvent || savedEvent.snapshot !== snapshot || typeof savedEvent.id !== "string") {
    savedEvent = { id: crypto.randomUUID(), snapshot };
    sessionStorage.setItem(eventKey, JSON.stringify(savedEvent));
  }
  const eventId = savedEvent.id;
  requestBusy = true;
  button.disabled = true;
  message.textContent = "Salvando encomenda…";
  try {
    const result = await api("/api/sector/orders", { method: "POST", body: JSON.stringify({ event_id: eventId, order, items }) });
    sessionStorage.removeItem(eventKey);
    orderForm.reset();
    itemRows.innerHTML = "";
    addOrderItemRow();
    message.textContent = `Encomenda ${result.order?.display_id || ""} registrada no portal.`;
    showNotice("A encomenda foi cadastrada somente no portal independente.", "success");
    await loadPortalOrders();
  } catch (error) {
    message.textContent = error.message;
    if (error.status && error.status < 500) sessionStorage.removeItem(eventKey);
  } finally {
    requestBusy = false;
    button.disabled = false;
  }
});

document.querySelector("#reload-accounts").addEventListener("click", loadAccounts);
document.querySelector("#reload-orders").addEventListener("click", loadPortalOrders);
rows.addEventListener("click", async event => {
  const button = event.target.closest("button[data-id]");
  if (!button || requestBusy) return;
  requestBusy = true;
  button.disabled = true;
  try {
    await api("/api/sector/accounts", {
      method: "PATCH",
      body: JSON.stringify({ id: button.dataset.id, active: button.dataset.active === "true" })
    });
    showNotice("Situação da conta atualizada.", "success");
    await loadAccounts();
  } catch (error) {
    showNotice(error.message, "error");
    button.disabled = false;
  } finally {
    requestBusy = false;
  }
});

init();
