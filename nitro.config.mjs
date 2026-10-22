import { defineConfig } from "nitro";

export default defineConfig({
  // As rotas Nitro são adaptadores finos; a lógica dos handlers e integrações fica em api/ e lib/.
  serverEntry: false,
  // Mantém o roteamento no servidor Nitro; o split automático da Vercel encaminha rotas incorretas.
  compatibilityDate: { vercel: "2025-07-14" },
  serverDir: "./routes",
  preset: "vercel",
  vercel: {
    entryFormat: "node",
    queues: {
      triggers: [
        { topic: "whatsapp-notifications", retryAfterSeconds: 60 }
      ]
    },
    functions: {
      runtime: "nodejs24.x",
      includeFiles: ["server-handlers/**/*", "lib/**/*"]
    }
  }
});

