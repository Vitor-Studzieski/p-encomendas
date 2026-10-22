import { definePlugin } from "nitro";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { processWhatsappOutbox } = require("../../lib/whatsapp-outbox.js");

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("vercel:queue", async ({ message, metadata }) => {
    if (metadata.topicName !== "whatsapp-notifications") return;
    const outboxId = String(message?.outboxId || "");
    if (!outboxId) throw new Error("Mensagem da fila sem outboxId.");
    await processWhatsappOutbox(outboxId, metadata);
  });
});
