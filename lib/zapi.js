"use strict";

const { phoneDigits } = require("./phones");

async function sendText(phone, message, options = {}) {
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const instanceToken = process.env.ZAPI_INSTANCE_TOKEN;
  const clientToken = process.env.ZAPI_CLIENT_TOKEN;
  if (!instanceId || !instanceToken || !clientToken) {
    throw Object.assign(new Error("As credenciais da Z-API não estão configuradas."), { statusCode: 503 });
  }
  const recipient = phoneDigits(phone);
  if (!/^\d{12,13}$/.test(recipient)) throw Object.assign(new Error("Telefone do WhatsApp inválido."), { statusCode: 422 });

  const url = `https://api.z-api.io/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(instanceToken)}/send-text`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "Client-Token": clientToken },
      body: JSON.stringify({ phone: recipient, message, ...(options.replyTo ? { messageId: options.replyTo } : {}) }),
      signal: AbortSignal.timeout(12000)
    });
  } catch (error) {
    throw Object.assign(new Error("Não foi possível alcançar a API da Z-API."), { statusCode: 502, cause: error });
  }
  const raw = await response.text();
  if (!response.ok) {
    // Provider error bodies can echo request data. Keep details out of logs and responses.
    throw Object.assign(new Error(`A Z-API recusou o envio (HTTP ${response.status}).`), { statusCode: 502 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

module.exports = { sendText };
