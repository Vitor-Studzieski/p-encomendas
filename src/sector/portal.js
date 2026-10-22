const loginPanel = document.querySelector("#login-panel");
const workPanel = document.querySelector("#work-panel");
const loginForm = document.querySelector("#login-form");
const loginMessage = document.querySelector("#login-message");
const passwordPanel = document.querySelector("#password-panel");
const passwordForm = document.querySelector("#password-form");
const passwordMessage = document.querySelector("#password-message");
const banner = document.querySelector("#portal-banner");
const title = document.querySelector("#portal-title");
const subtitle = document.querySelector("#portal-subtitle");
const workHeading = document.querySelector("#work-heading");
const workCaption = document.querySelector("#work-caption");
const workSummary = document.querySelector("#work-summary");
const workList = document.querySelector("#work-list");
const headerStatus = document.querySelector("#header-status-text");

let currentAccount = null;
let busy = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function dateLabel(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "Data a confirmar";
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function stateLabel(stage) {
  return ({
    awaiting_confirmation: "Aguardando confirmação",
    blocked: "Aguardando confirmação de outro setor",
    planned: "Na fila de produção",
    in_progress: "Em produção",
    completed: "Pronto para retirada",
    needs_attention: "Precisa de atenção"
  })[stage] || "Em andamento";
}

function showBanner(message, type = "info") {
  banner.textContent = message;
  banner.className = `portal-banner portal-banner-${type}`;
  banner.hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.message || "A solicitação não foi concluída."), { status: response.status });
  return data;
}

function showSignedOut() {
  currentAccount = null;
  loginPanel.hidden = false;
  passwordPanel.hidden = true;
  workPanel.hidden = true;
  headerStatus.textContent = "Acesso do setor";
}

function showSignedIn(account) {
  currentAccount = account;
  loginPanel.hidden = true;
  passwordPanel.hidden = account.must_change_password === true;
  workPanel.hidden = account.must_change_password === true;
  headerStatus.textContent = account.role === "fiscal" ? "Fiscal" : account.sector_name;
  if (account.must_change_password === true) {
    title.textContent = "Troca de senha obrigatória";
    subtitle.textContent = "Defina uma senha pessoal para liberar o acesso à operação.";
    return;
  }
  title.textContent = account.role === "fiscal" ? "Fila da Fiscal" : `Operação · ${account.sector_name}`;
  subtitle.textContent = account.role === "fiscal"
    ? "Revise impedimentos informados pelos setores e registre a decisão."
    : "Confirme a encomenda e atualize o andamento da produção da sua equipe.";
}

function itemRows(items) {
  if (!items?.length) return "<li>Itens não disponíveis</li>";
  return items.map(item => {
    const size = item.size_label ? ` · ${escapeHtml(item.size_label)}` : "";
    return `<li><strong>${escapeHtml(item.quantity)}×</strong> ${escapeHtml(item.name)}${size}</li>`;
  }).join("");
}

function reviewNotice(reviews = []) {
  const pending = reviews.find(review => review.status === "pending");
  if (pending) {
    return `<div class="review-note review-note-pending"><strong>Análise da Fiscal em andamento</strong>${pending.reason ? `<span>${escapeHtml(pending.reason)}</span>` : ""}</div>`;
  }
  const returned = reviews.find(review => review.status === "returned_to_sector");
  if (returned) {
    return `<div class="review-note review-note-returned"><strong>A Fiscal liberou o retorno à produção</strong>${returned.fiscal_resolution ? `<span>${escapeHtml(returned.fiscal_resolution)}</span>` : ""}</div>`;
  }
  return "";
}

function orderDetails(card) {
  const date = dateLabel(card.requested_date);
  const pickup = [date, card.requested_time].filter(Boolean).join(" · ");
  return `<dl class="order-details">
    <div><dt>Retirada</dt><dd>${escapeHtml(pickup || date)}</dd></div>
    ${card.pickup_location ? `<div><dt>Local</dt><dd>${escapeHtml(card.pickup_location)}</dd></div>` : ""}
    ${card.customer?.name ? `<div><dt>Cliente</dt><dd>${escapeHtml(card.customer.name)}</dd></div>` : ""}
    ${card.customer?.phone ? `<div><dt>Contato</dt><dd>${escapeHtml(card.customer.phone)}</dd></div>` : ""}
  </dl>`;
}

function sectorActions(card) {
  const pendingReview = card.reviews?.some(review => review.status === "pending");
  const buttons = [];
  if (card.stage === "awaiting_confirmation") {
    if (!pendingReview) buttons.push(`<button class="button button-primary" data-action="confirm" data-order="${escapeHtml(card.order_id)}">Confirmar produção</button>`);
    if (!pendingReview) buttons.push(`<button class="button button-secondary" data-action="request_review" data-order="${escapeHtml(card.order_id)}">Pedir análise da Fiscal</button>`);
  } else if (card.stage === "planned") {
    buttons.push(`<button class="button button-primary" data-action="start_preparing" data-order="${escapeHtml(card.order_id)}">Iniciar produção</button>`);
  } else if (card.stage === "in_progress" || card.stage === "needs_attention") {
    if (card.stage === "in_progress") buttons.push(`<button class="button button-primary" data-action="mark_ready" data-order="${escapeHtml(card.order_id)}">Marcar pronto</button>`);
    if (!pendingReview && card.stage === "in_progress") buttons.push(`<button class="button button-secondary" data-action="request_review" data-order="${escapeHtml(card.order_id)}">Pedir análise da Fiscal</button>`);
  }
  return buttons.length ? `<div class="card-actions">${buttons.join("")}</div>` : "";
}

function sectorCard(card) {
  const pendingReview = card.reviews?.some(review => review.status === "pending");
  const stage = pendingReview ? "needs_attention" : card.stage;
  return `<article class="work-card">
    <div class="card-topline"><div><p class="eyebrow">${escapeHtml(card.sector_name || currentAccount.sector_name)}</p><h3>${escapeHtml(card.display_id)}</h3></div><span class="stage-pill stage-${escapeHtml(stage)}">${stateLabel(pendingReview ? "needs_attention" : card.stage)}</span></div>
    ${orderDetails(card)}
    <div class="card-items"><h4>Itens da equipe</h4><ul>${itemRows(card.items)}</ul></div>
    ${reviewNotice(card.reviews)}
    <div class="card-feedback" aria-live="polite"></div>
    ${sectorActions(card)}
  </article>`;
}

function fiscalCard(card) {
  return `<article class="work-card fiscal-card" data-review-id="${escapeHtml(card.review?.id)}">
    <div class="card-topline"><div><p class="eyebrow">${escapeHtml(card.review?.sector_name || "Setor")}</p><h3>${escapeHtml(card.display_id)}</h3></div><span class="stage-pill stage-needs_attention">Aguardando análise</span></div>
    ${orderDetails(card)}
    <div class="card-items"><h4>Itens do setor</h4><ul>${itemRows(card.items)}</ul></div>
    ${card.review?.reason ? `<div class="review-note review-note-pending"><strong>Motivo informado pelo setor</strong><span>${escapeHtml(card.review.reason)}</span></div>` : ""}
    ${card.review?.fiscal_resolution ? `<div class="review-note review-note-returned"><strong>Análise anterior</strong><span>${escapeHtml(card.review.fiscal_resolution)}</span></div>` : ""}
    <label class="resolution-field">Registro da análise<textarea rows="3" maxlength="1000" required placeholder="Descreva a alternativa encontrada ou por que não será possível produzir."></textarea><small>Este registro fica no histórico. Verifique alternativas com o setor; o portal não envia mensagens ao cliente.</small></label>
    <div class="card-feedback" aria-live="polite"></div>
    <div class="card-actions"><button class="button button-primary" data-action="fiscal_possible" data-review="${escapeHtml(card.review?.id)}">Produção possível · devolver ao setor</button><button class="button button-danger" data-action="fiscal_impossible" data-review="${escapeHtml(card.review?.id)}">Não será possível produzir</button></div>
  </article>`;
}

function renderWorkboard(result) {
  const cards = result.data || [];
  workHeading.textContent = result.role === "fiscal" ? "Análises pendentes" : `Fila · ${currentAccount.sector_name}`;
  workCaption.textContent = result.role === "fiscal"
    ? "A equipe da Fiscal confirma a possibilidade de produção ou encerra a análise."
    : "Cada equipe vê somente as encomendas e os itens atribuídos ao seu setor.";
  const counts = result.role === "fiscal"
    ? [{ number: cards.length, label: "Aguardando análise" }]
    : [
      { number: cards.filter(card => card.stage === "awaiting_confirmation").length, label: "Aguardando confirmação" },
      { number: cards.filter(card => card.stage === "planned").length, label: "Na fila" },
      { number: cards.filter(card => card.stage === "in_progress").length, label: "Em produção" },
      { number: cards.filter(card => card.stage === "completed").length, label: "Prontos" }
    ];
  workSummary.innerHTML = counts.map(item => `<div class="summary-item"><strong>${String(item.number).padStart(2, "0")}</strong><span>${escapeHtml(item.label)}</span></div>`).join("");
  if (!cards.length) {
    workList.innerHTML = `<div class="empty-work"><span class="empty-mark">✓</span><h3>${result.role === "fiscal" ? "Nenhuma análise pendente" : "Sua fila está em dia"}</h3><p>${result.role === "fiscal" ? "Quando um setor pedir análise, a solicitação aparecerá aqui." : "Novas encomendas destinadas ao seu setor aparecerão aqui."}</p></div>`;
    return;
  }
  workList.innerHTML = cards.map(result.role === "fiscal" ? fiscalCard : sectorCard).join("");
}

async function loadWorkboard(force = false) {
  if (!currentAccount || (busy && !force)) return;
  busy = true;
  document.querySelector("#refresh-button").disabled = true;
  try {
    const result = await api("/api/sector/workboard");
    showBanner("");
    renderWorkboard(result);
  } catch (error) {
    showBanner(error.message, "error");
  } finally {
    busy = false;
    document.querySelector("#refresh-button").disabled = false;
  }
}

async function init() {
  try {
    const result = await api("/api/sector/session");
    if (result.authenticated) {
      if (result.account.role === "manager") {
        window.location.replace("/contas-setores.html");
        return;
      }
      showSignedIn(result.account);
      if (!result.account.must_change_password) await loadWorkboard();
    } else showSignedOut();
  } catch (error) {
    showSignedOut();
    showBanner(error.message, "error");
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = document.querySelector("#login-button");
  button.disabled = true;
  loginMessage.textContent = "Entrando…";
  try {
    const result = await api("/api/sector/session", {
      method: "POST",
      body: JSON.stringify({ email: document.querySelector("#login-email").value.trim(), password: document.querySelector("#login-password").value })
    });
    if (result.account.role === "manager") {
      window.location.assign("/contas-setores.html");
      return;
    }
    loginForm.reset();
    loginMessage.textContent = "";
    showBanner("");
    showSignedIn(result.account);
    busy = false;
    if (!result.account.must_change_password) await loadWorkboard(true);
  } catch (error) {
    loginMessage.textContent = error.message;
  } finally {
    busy = false;
    button.disabled = false;
  }
});

passwordForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  const password = document.querySelector("#new-password").value;
  const confirmation = document.querySelector("#confirm-password").value;
  if (password !== confirmation) {
    passwordMessage.textContent = "As senhas não coincidem.";
    return;
  }
  busy = true;
  const button = document.querySelector("#password-button");
  button.disabled = true;
  passwordMessage.textContent = "Salvando…";
  try {
    await api("/api/sector/password", { method: "POST", body: JSON.stringify({ password }) });
    passwordForm.reset();
    passwordMessage.textContent = "Senha atualizada.";
    currentAccount.must_change_password = false;
    showSignedIn(currentAccount);
    showBanner("Senha atualizada. Acesso liberado.", "success");
    busy = false;
    await loadWorkboard(true);
  } catch (error) {
    passwordMessage.textContent = error.message;
  } finally {
    busy = false;
    button.disabled = false;
  }
});

document.querySelector("#refresh-button").addEventListener("click", () => loadWorkboard());
document.querySelector("#logout-button").addEventListener("click", async () => {
  try { await api("/api/sector/session", { method: "DELETE" }); }
  catch { /* Limpa a tela local mesmo se o serviço de sessão estiver indisponível. */ }
  showSignedOut();
  workList.innerHTML = "";
  showBanner("Sessão encerrada.", "info");
});

workList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled || busy) return;
  const card = button.closest(".work-card");
  const feedback = card?.querySelector(".card-feedback");
  const action = button.dataset.action;
  const body = { action };
  if (button.dataset.order) body.order_id = button.dataset.order;
  if (button.dataset.review) body.review_id = button.dataset.review;
  if (action === "request_review") {
    const reason = window.prompt("Descreva o impedimento para a Fiscal analisar:", "");
    if (reason === null) return;
    if (!reason.trim()) {
      if (feedback) feedback.textContent = "Informe o impedimento antes de solicitar a análise.";
      return;
    }
    body.reason = reason.trim();
  }
  if (action.startsWith("fiscal_")) {
    const resolution = card?.querySelector("textarea")?.value.trim() || "";
    if (!resolution) {
      if (feedback) feedback.textContent = "Registre a conclusão da análise antes de continuar.";
      card?.querySelector("textarea")?.focus();
      return;
    }
    body.resolution = resolution;
  }
  if (action === "fiscal_impossible" && !window.confirm("Confirma que a análise foi concluída e que não será possível produzir este pedido?")) return;
  const actionIdentity = `${currentAccount?.id || "account"}:${action}:${body.order_id || body.review_id || ""}`;
  const pendingKey = `sector-action:${actionIdentity}`;
  let eventId = sessionStorage.getItem(pendingKey);
  if (!eventId) {
    eventId = crypto.randomUUID();
    sessionStorage.setItem(pendingKey, eventId);
  }
  body.event_id = eventId;
  busy = true;
  button.disabled = true;
  if (feedback) feedback.textContent = "Salvando…";
  try {
    const actionResult = await api("/api/sector/actions", { method: "POST", body: JSON.stringify(body) });
    sessionStorage.removeItem(pendingKey);
    const warnings = [...(actionResult.warnings || []), ...(actionResult.result?.warnings || [])];
    showBanner(warnings.length
      ? warnings.map(warning => warning.message).filter(Boolean).join(" ")
      : action === "fiscal_impossible" ? "Pedido encerrado no portal. A Fiscal deve avisar o cliente pelos canais da loja." : "Atualização registrada no portal.",
    warnings.length ? "error" : "success");
    busy = false;
    await loadWorkboard(true);
  } catch (error) {
    if (feedback) feedback.textContent = error.message;
    if (error.status && error.status < 500) sessionStorage.removeItem(pendingKey);
    button.disabled = false;
  } finally {
    busy = false;
  }
});

init();
