import { loadEnv, defineConfig } from "vite";
import { nitro } from "nitro/vite";
import { workflow } from "workflow/vite";

export default defineConfig(({ mode }) => {
  const localEnvironment = loadEnv(mode, process.cwd(), "");
  for (const [name, value] of Object.entries(localEnvironment)) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) process.env[name] = value;
  }

  return {
    // No server environment variable is intentionally exposed through import.meta.env.
    envPrefix: "DASHBOARD_PUBLIC_",
    plugins: [
      nitro(),
      workflow({ dirs: ["./workflows"], runtime: "nodejs24.x" })
    ],
    server: {
      host: "127.0.0.1",
      port: 8766,
      strictPort: true
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          dashboard: "index.html",
          orderForm: "pedido.html",
          survey: "avaliacao.html"
        }
      }
    }
  };
});

