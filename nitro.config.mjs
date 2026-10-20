import { defineConfig } from "nitro";

export default defineConfig({
  // As rotas Nitro são adaptadores finos; a lógica dos handlers e integrações fica em api/ e lib/.
  serverEntry: false,
  serverDir: "./routes",
  preset: "vercel",
  vercel: {
    functions: {
      runtime: "nodejs24.x",
      includeFiles: ["api/**/*", "lib/**/*"]
    }
  }
});

