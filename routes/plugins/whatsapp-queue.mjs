import { definePlugin } from "nitro";
import whatsappOutbox from "../../lib/whatsapp-outbox.js";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("vercel:queue", async ({ message, metadata }) => {
    if (metadata.topicName !== "whatsapp-notifications") return;
    const outboxId = String(message?.outboxId || "");
    if (!outboxId) throw new Error("Mensagem da fila sem outboxId.");
    await whatsappOutbox.processWhatsappOutbox(outboxId, metadata);
  });
});
