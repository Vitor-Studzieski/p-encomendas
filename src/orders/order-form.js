"use strict";

import { mountOrderItems } from "../shared/order-items.js";

const form = document.getElementById("public-order-form");
const status = document.getElementById("form-status");
const submitButton = form.querySelector("button[type=submit]");
const orderTextInput = document.getElementById("public-order-text");
const orderTextPreview = document.getElementById("order-text-preview");
const originalSubmitMarkup = submitButton.innerHTML;
let itemEditor;
let parsedOrder = null;
let parsedOrderText = "";
let manualItemsSnapshot = null;
let parseTimer = null;
let parseSequence = 0;
submitButton.disabled = true;
const itemEditorReady = mountOrderItems(document.getElementById("public-order-items"))
  .then(editor => { itemEditor = editor; if (!orderTextInput.value.trim()) submitButton.disabled = false; })
  .catch(error => { status.textContent = error.message; });
const formToken = new URLSearchParams(location.hash.slice(1));
const access = formToken.get("acesso") || "";
const expires = Number(formToken.get("expira") || 0);

function setPreviewMessage(message, className = "") {
  orderTextPreview.replaceChildren();
  orderTextPreview.className = "order-text-preview" + (className ? " " + className : "");
  orderTextPreview.textContent = message;
  orderTextPreview.hidden = !message;
}

function renderOrderPreview(data) {
  orderTextPreview.replaceChildren();
  orderTextPreview.className = "order-text-preview";
  const title = document.createElement("strong");
  title.textContent = "Confirme o pedido";
  const sector = document.createElement("p");
  sector.className = "order-text-preview-sector";
  sector.textContent = "Setor único: " + data.sector;
  const list = document.createElement("ul");
  for (const item of data.items) {
    const row = document.createElement("li");
    const quantity = Number(item.quantity).toLocaleString("pt-BR");
    row.textContent = quantity + " " + (item.unit || "un") + " · " + item.name;
    list.append(row);
  }
  orderTextPreview.append(title, sector, list);
  orderTextPreview.hidden = false;
}

function clearOrderTextMode() {
  clearTimeout(parseTimer);
  parseSequence += 1;
  parsedOrder = null;
  parsedOrderText = "";
  orderTextPreview.hidden = true;
  orderTextPreview.replaceChildren();
  if (itemEditor) {
    itemEditor.setReadOnly(false);
    if (manualItemsSnapshot) itemEditor.setItems(manualItemsSnapshot);
    else itemEditor.reset();
    submitButton.disabled = false;
  }
  manualItemsSnapshot = null;
  submitButton.innerHTML = originalSubmitMarkup;
}

async function resolveOrderText(text, sequence) {
  try {
    await itemEditorReady;
    if (!itemEditor || sequence !== parseSequence || text !== orderTextInput.value.trim()) return;
    if (!manualItemsSnapshot) manualItemsSnapshot = itemEditor.getRawItems();
    const response = await fetch("/api/public/order-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ acesso: access, expira: expires, order_text: text })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Não foi possível identificar os produtos.");
    if (sequence !== parseSequence || text !== orderTextInput.value.trim()) return;
    parsedOrder = result.data;
    parsedOrderText = text;
    itemEditor.setItems(parsedOrder.items);
    itemEditor.setReadOnly(true);
    renderOrderPreview(parsedOrder);
    submitButton.innerHTML = "Confirmar e enviar encomenda <span aria-hidden=\"true\">→</span>";
    submitButton.disabled = false;
  } catch (error) {
    if (sequence !== parseSequence || text !== orderTextInput.value.trim()) return;
    parsedOrder = null;
    parsedOrderText = "";
    if (itemEditor) itemEditor.setReadOnly(false);
    setPreviewMessage(error.message || "Não foi possível identificar os produtos.", "order-text-preview-error");
    submitButton.disabled = true;
  }
}

orderTextInput.addEventListener("input", () => {
  clearTimeout(parseTimer);
  const text = orderTextInput.value.trim();
  parsedOrder = null;
  parsedOrderText = "";
  const sequence = ++parseSequence;
  if (!text) {
    clearOrderTextMode();
    return;
  }
  if (!manualItemsSnapshot && itemEditor) manualItemsSnapshot = itemEditor.getRawItems();
  if (manualItemsSnapshot && itemEditor) itemEditor.setItems(manualItemsSnapshot);
  submitButton.disabled = true;
  if (itemEditor) itemEditor.setReadOnly(true);
  setPreviewMessage("Identificando produtos no catálogo…");
  parseTimer = setTimeout(() => resolveOrderText(text, sequence), 700);
});

function parsePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const full = digits.startsWith("55") ? digits : "55" + digits;
  if (!/^55\d{10,11}$/.test(full)) throw new Error("Informe um WhatsApp válido com DDD.");
  return "+" + full;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  status.textContent = "";
  status.className = "";
  if (!access) { status.textContent = "Este link não é válido. Peça um novo link à operação."; return; }
  const button = form.querySelector("button[type=submit]");
  try {
    await itemEditorReady;
    if (!itemEditor) throw new Error("Não foi possível carregar os setores. Atualize a página e tente novamente.");
    const data = new FormData(form);
    const typedOrder = orderTextInput.value.trim();
    if (typedOrder && (!parsedOrder || parsedOrderText !== typedOrder)) {
      throw new Error("Aguarde a identificação do pedido. Se preferir, apague o texto para preencher os produtos manualmente.");
    }
    const items = typedOrder ? parsedOrder.items : itemEditor.getItems();
    const isTextOrder = Boolean(typedOrder);
    button.disabled = true;
    const response = await fetch("/api/public/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        acesso: access,
        expira: expires,
        customer_name: String(data.get("customer_name") || "").trim(),
        customer_phone: parsePhone(data.get("customer_phone")),
        requested_date: data.get("requested_date"),
        requested_time: data.get("requested_time"),
        pickup_location: String(data.get("pickup_location") || "").trim(),
        items,
        notes: String(data.get("notes") || "").trim()
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Não foi possível enviar a encomenda.");
    form.reset();
    parsedOrder = null;
    parsedOrderText = "";
    manualItemsSnapshot = null;
    orderTextPreview.hidden = true;
    orderTextPreview.replaceChildren();
    orderTextPreview.className = "order-text-preview";
    submitButton.innerHTML = originalSubmitMarkup;
    itemEditor.reset();
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      const warningMessages = warnings.map(warning => {
        const recipient = warning.tag === "order-created-bakery" ? "Padaria: "
          : warning.tag === "order-created-customer" ? "Cliente: "
            : "";
        return recipient + String(warning.message || "Não foi possível enviar uma notificação.");
      });
      status.className = "status-warning";
      status.textContent = "Pedido " + (result.order_ref || "") + " registrado no painel, mas houve falha em uma notificação: " + warningMessages.join(" ") + " Não envie novamente para evitar duplicidade.";
    } else {
      status.className = "status-success";
      status.textContent = isTextOrder
        ? "Pedido enviado. A equipe de Confeitaria vai confirmar a disponibilidade e receberá os itens."
        : "Pedido enviado. A Padaria vai confirmar a disponibilidade; depois, os setores selecionados receberão seus itens.";
    }
  } catch (error) {
    status.className = "status-error";
    status.textContent = error.message || "Não foi possível enviar a encomenda.";
  } finally {
    button.disabled = !itemEditor || Boolean(orderTextInput.value.trim() && (!parsedOrder || parsedOrderText !== orderTextInput.value.trim()));
  }
});

