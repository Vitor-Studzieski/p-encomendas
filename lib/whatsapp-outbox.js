"use strict";

const { rpc } = require("./supabase");
const { sendText } = require("./zapi");

const WHATSAPP_TOPIC = "whatsapp-notifications";

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function firstRecord(value) {
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === "object" ? value : {};
}

async function publishWhatsappOutboxIds(ids) {
  const { send } = await import("@vercel/queue");
  const warnings = [];
  for (const rawId of asArray(ids)) {
    const id = String(rawId || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      warnings.push({ id, message: "A caixa de saída retornou um identificador inválido." });
      continue;
    }
    try {
      await send(WHATSAPP_TOPIC, { outboxId: id }, { idempotencyKey: "whatsapp-outbox:" + id });
      await rpc("dashboard_mark_whatsapp_outbox_queued", { p_outbox_id: id });
    } catch (error) {
      warnings.push({ id, message: error.message || "Não foi possível publicar a mensagem na fila." });
      console.error("Falha ao publicar notificação " + id + " na fila do WhatsApp: " + (error.message || error));
    }
  }
  return warnings;
}

async function enqueueWhatsappNotification(notification) {
  const result = firstRecord(await rpc("dashboard_enqueue_whatsapp_outbox", {
    p_event_id: notification.event_id,
    p_event_type: notification.event_type,
    p_order_ref: notification.order_ref || "",
    p_notifications: [{
      dedupe_key: notification.dedupe_key,
      phone: notification.phone,
      message: notification.message,
      tag: notification.tag
    }]
  }));
  const ids = asArray(result.outbox_ids);
  const warnings = await publishWhatsappOutboxIds(ids);
  return { outboxIds: ids, warnings };
}

async function publishPendingWhatsappOutbox(limit = 50) {
  const result = await rpc("dashboard_list_whatsapp_outbox_to_publish", { p_limit: limit });
  const ids = asArray(result).map(row => row?.id).filter(Boolean);
  return { outboxIds: ids, warnings: await publishWhatsappOutboxIds(ids) };
}

async function processWhatsappOutbox(outboxId, metadata = {}) {
  const claim = firstRecord(await rpc("dashboard_claim_whatsapp_outbox", { p_outbox_id: outboxId }));
  if (["sent", "dead"].includes(claim.status)) return { status: claim.status };
  if (claim.status !== "processing") {
    throw new Error("A notificação ainda está em espera para uma nova tentativa.");
  }

  try {
    await sendText(claim.recipient_phone_e164, claim.message);
  } catch (error) {
    let failure;
    try {
      failure = firstRecord(await rpc("dashboard_fail_whatsapp_outbox", {
        p_outbox_id: outboxId,
        p_error: error.message || "Falha desconhecida ao enviar mensagem."
      }));
    } catch (ledgerError) {
      throw new Error("O envio do WhatsApp falhou e não foi possível registrar a tentativa: " + (ledgerError.message || ledgerError));
    }
    if (failure.status === "dead") {
      console.error("Notificação movida para estado final após 8 tentativas.", {
        outboxId,
        topic: metadata.topicName || WHATSAPP_TOPIC,
        tag: claim.tag
      });
      return { status: "dead", attempts: failure.attempts };
    }
    throw error;
  }

  const completed = await rpc("dashboard_complete_whatsapp_outbox", { p_outbox_id: outboxId });
  if (completed !== true) throw new Error("A mensagem foi aceita pela Z-API, mas o banco não confirmou a conclusão da entrega.");
  return { status: "sent", attempts: claim.attempts };
}

module.exports = {
  WHATSAPP_TOPIC,
  enqueueWhatsappNotification,
  processWhatsappOutbox,
  publishPendingWhatsappOutbox,
  publishWhatsappOutboxIds
};
