"use strict";

const params = new URLSearchParams(location.hash.slice(1));
const legacyParams = new URLSearchParams(location.search);
const form = document.getElementById("survey-form");
const status = document.getElementById("survey-status");
const token = {
  order_ref: params.get("pedido") || legacyParams.get("pedido") || "",
  expires: Number(params.get("expira") || legacyParams.get("expira") || 0),
  signature: params.get("assinatura") || legacyParams.get("assinatura") || ""
};

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  const data = new FormData(form);
  button.disabled = true;
  try {
    const response = await fetch("/api/public/survey", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        ...token,
        rating: Number(data.get("rating")),
        comment: String(data.get("comment") || "").trim()
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "Não foi possível registrar sua avaliação.");
    form.innerHTML = "<div class=\"survey-thanks\" role=\"status\">Obrigado pela avaliação. Ela já foi enviada à equipe da padaria.</div>";
  } catch (error) {
    status.textContent = error.message || "Não foi possível registrar sua avaliação.";
    button.disabled = false;
  }
});

