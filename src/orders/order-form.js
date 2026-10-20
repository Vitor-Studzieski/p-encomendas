"use strict";

import { mountOrderItems } from "../shared/order-items.js";

const form = document.getElementById("public-order-form");
const status = document.getElementById("form-status");
const submitButton = form.querySelector("button[type=submit]");
let itemEditor;
submitButton.disabled = true;
const itemEditorReady = mountOrderItems(document.getElementById("public-order-items"))
  .then(editor => { itemEditor = editor; submitButton.disabled = false; })
  .catch(error => { status.textContent = error.message; });
const formToken = new URLSearchParams(location.hash.slice(1));
const access = formToken.get("acesso") || "";
const expires = Number(formToken.get("expira") || 0);

function parsePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const full = digits.startsWith("55") ? digits : "55" + digits;
  if (!/^55\d{10,11}$/.test(full)) throw new Error("Informe um WhatsApp válido com DDD.");
  return "+" + full;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!access) { status.textContent = "Este link não é válido. Peça um novo link à operação."; return; }
  const button = form.querySelector("button[type=submit]");
  try {
    await itemEditorReady;
    if (!itemEditor) throw new Error("Não foi possível carregar os setores. Atualize a página e tente novamente.");
    const data = new FormData(form);
    const items = itemEditor.getItems();
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
    itemEditor.reset();
    status.textContent = "Pedido enviado. A Padaria vai confirmar a disponibilidade; depois, os setores selecionados receberão seus itens.";
  } catch (error) {
    status.textContent = error.message || "Não foi possível enviar a encomenda.";
  } finally {
    button.disabled = !itemEditor;
  }
});

