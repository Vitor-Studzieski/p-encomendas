import { loadEnv, defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { nitro } from "nitro/vite";
import { workflow } from "workflow/vite";

function dashboardDevRoutePlugin() {
  return {
    name: "dashboard-html-dev-route",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url || "/", "http://localhost").pathname;
        if (!new Set(["GET", "HEAD"]).has(request.method) || pathname !== "/dashboard.html") return next();
        try {
          const html = await readFile(resolve(process.cwd(), "dashboard.html"), "utf8");
          const transformed = await server.transformIndexHtml(pathname, html);
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(request.method === "HEAD" ? undefined : transformed);
        } catch (error) {
          next(error);
        }
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const localEnvironment = loadEnv(mode, process.cwd(), "");
  for (const [name, value] of Object.entries(localEnvironment)) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) process.env[name] = value;
  }

  return {
    // No server environment variable is intentionally exposed through import.meta.env.
    envPrefix: "DASHBOARD_PUBLIC_",
    appType: "mpa",
    plugins: [
      dashboardDevRoutePlugin(),
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
          home: "index.html",
          dashboard: "dashboard.html",
          orderForm: "pedido.html",
          survey: "avaliacao.html"
        }
      }
    }
  };
});

