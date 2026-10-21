"use strict";

import { mountOrderItems } from "./catalog-order-items.js";
import { clearSessionDraft, fingerprintPayload, readSessionDraft, writeSessionDraft } from "../shared/idempotency.js";

const form = document.getElementById("public-order-form");
const status = document.getElementById("form-status");
const submitButton = form.querySelector("button[type=submit]");
const confirmation = document.getElementById("order-confirmation");
const confirmationSummary = confirmation.querySelector("[data-confirmation-summary]");
const confirmButton = confirmation.querySelector("[data-confirm-order]");
const submissionStorageKey = "fiscal-order-submission-v3";
const formToken = new URLSearchParams(location.hash.slice(1));
const access = formToken.get("acesso") || "";
const expires = Number(formToken.get("expira") || 0);
let itemEditor;
let preparedPayload = null;
let pendingSubmission = readSessionDraft(submissionStorageKey);
let isSubmitting = false;

submitButton.disabled = true;
const itemEditorReady = mountOrderItems(document.getElementById("public-order-items"), { access, expires })
  .then(editor => { itemEditor = editor; submitButton.disabled = false; })
  .catch(error => {
    status.className = "status-error";
    status.textContent = error.message || "Não foi possível carregar o catálogo de produtos.";
  });

function parsePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const full = digits.startsWith("55") ? digits : "55" + digits;
  if (!/^55\d{10,11}$/.test(full)) throw new Error("Informe um WhatsApp válido com DDD.");
  return "+" + full;
}

function renderConfirmation(payload) {
  confirmationSummary.replaceChildren();
  const list = document.createElement("ul");
  for (const item of payload.items) {
    const row = document.createElement("li");
    const size = item.size_label ? " · " + item.size_label : "";
    row.textContent = `${Number(item.quantity).toLocaleString("pt-BR")} ${item.unit || "un"} · ${item.name}${size}`;
    list.append(row);
  }
  confirmationSummary.append(list);
  if (payload.notes) {
    const notes = document.createElement("p");
    notes.className = "order-confirmation-notes";
    notes.textContent = "Observações: " + payload.notes;
    confirmationSummary.append(notes);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!access) {
    status.textContent = "Este link não é válido. Peça um novo link à operação.";
    return;
  }

  status.textContent = "";
  status.className = "";
  try {
    await itemEditorReady;
    if (!itemEditor) throw new Error("Não foi possível carregar o catálogo. Atualize a página e tente novamente.");
    const data = new FormData(form);
    preparedPayload = {
      acesso: access,
      expira: expires,
      customer_name: String(data.get("customer_name") || "").trim(),
      customer_phone: parsePhone(data.get("customer_phone")),
      requested_date: data.get("requested_date"),
      requested_time: data.get("requested_time"),
      pickup_location: String(data.get("pickup_location") || "").trim(),
      items: itemEditor.getItems(),
      notes: String(data.get("notes") || "").trim()
    };
    renderConfirmation(preparedPayload);
    if (typeof confirmation.showModal === "function") confirmation.showModal();
    else if (window.confirm("Confirma o envio desta encomenda à Padaria para aprovação?")) await submitOrder();
  } catch (error) {
    status.className = "status-error";
    status.textContent = error.message || "Confira os produtos e os tamanhos antes de continuar.";
  }
});

async function submitOrder() {
  if (!preparedPayload || isSubmitting) return;
  isSubmitting = true;
  confirmButton.disabled = true;
  submitButton.disabled = true;
  itemEditor.setDisabled(true);
  status.textContent = "Enviando encomenda…";
  try {
    const fingerprint = await fingerprintPayload(preparedPayload);
    if (!pendingSubmission || pendingSubmission.fingerprint !== fingerprint) {
      const eventId = crypto.randomUUID();
      pendingSubmission = {
        fingerprint,
        event_id: eventId,
        order_ref: "PENDING-" + eventId.toUpperCase()
      };
      writeSessionDraft(submissionStorageKey, pendingSubmission);
    }

    const response = await fetch("/api/public/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ...preparedPayload,
        event_id: pendingSubmission.event_id,
        order_ref: pendingSubmission.order_ref
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || "Não foi possível enviar a encomenda.");

    pendingSubmission = null;
    clearSessionDraft(submissionStorageKey);
    confirmation.close();
    form.reset();
    itemEditor.reset();
    preparedPayload = null;
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      const warningMessages = warnings.map(warning => {
        const recipient = warning.tag === "order-created-bakery" ? "Padaria: "
          : warning.tag === "order-created-customer" ? "Cliente: "
            : "";
        return recipient + String(warning.message || "Não foi possível enviar uma notificação.");
      });
      status.className = "status-warning";
      status.textContent = "Pedido " + (result.order_ref || "") + " registrado, mas houve falha em uma notificação: " + warningMessages.join(" ") + " Não envie novamente para evitar duplicidade.";
    } else {
      status.className = "status-success";
      status.textContent = "Pedido " + (result.order_ref || "enviado") + " enviado à Padaria para aprovação; os itens estão associados à Confeitaria.";
    }
  } catch (error) {
    if (confirmation.open) confirmation.close();
    status.className = "status-error";
    status.textContent = error.message || "Não foi possível enviar a encomenda.";
  } finally {
    isSubmitting = false;
    confirmButton.disabled = false;
    submitButton.disabled = !itemEditor;
    itemEditor?.setDisabled(false);
  }
}

confirmButton.addEventListener("click", submitOrder);
