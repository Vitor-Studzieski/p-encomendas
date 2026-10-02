"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = 8766;
const N8N_HOST = "127.0.0.1";
const N8N_PORT = 5678;
const MAX_BODY_BYTES = 1024 * 1024;

const apiRoutes = new Map([
  ["/api/orders", { path: "/webhook/dashboard/orders", methods: ["GET"] }],
  ["/api/settings", { path: "/webhook/dashboard/settings", methods: ["GET", "PUT"] }],
  ["/api/order-actions", { path: "/webhook/dashboard/order-actions", methods: ["POST"] }],
  ["/api/orders/create", { path: "/webhook/dashboard/orders/create", methods: ["POST"] }]
]);

const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/config.js", "config.js"],
  ["/styles.css", "styles.css"],
  ["/dashboard.css", "dashboard.css"]
]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function serveStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  const relativePath = staticFiles.get(pathname);
  if (!relativePath) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const filePath = path.join(__dirname, relativePath);
  fs.readFile(filePath, (error, body) => {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Não foi possível carregar a dashboard.");
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;

    request.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Payload muito grande."), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function proxyApi(request, response, route, search) {
  const token = request.headers["x-dashboard-token"];
  if (typeof token !== "string" || token.length === 0) {
    sendJson(response, 401, { message: "Conecte a dashboard com o token de acesso do n8n." });
    return;
  }

  let body;
  try {
    body = request.method === "GET" ? Buffer.alloc(0) : await readBody(request);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error.statusCode || 400, { message: error.message || "Requisição inválida." });
    }
    return;
  }

  const headers = {
    Accept: "application/json",
    "x-dashboard-token": token
  };
  if (body.length > 0) {
    headers["Content-Type"] = request.headers["content-type"] || "application/json";
    headers["Content-Length"] = body.length;
  }

  const upstream = http.request({
    hostname: N8N_HOST,
    port: N8N_PORT,
    path: route.path + search,
    method: request.method,
    headers,
    timeout: 15000
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, {
      "Cache-Control": "no-store",
      "Content-Type": upstreamResponse.headers["content-type"] || "application/json; charset=utf-8"
    });
    upstreamResponse.pipe(response);
    console.log(`${request.method} ${request.url} -> n8n ${upstreamResponse.statusCode || 502}`);
  });

  upstream.on("timeout", () => upstream.destroy(new Error("Tempo de conexão com n8n esgotado.")));
  upstream.on("error", error => {
    if (!response.headersSent) {
      sendJson(response, 502, { message: "Não foi possível conectar ao n8n local." });
    }
    console.error(`Falha no proxy para ${request.method} ${request.url}: ${error.message}`);
  });

  if (body.length > 0) upstream.write(body);
  upstream.end();
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === "/_health") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("ok");
    return;
  }

  const route = apiRoutes.get(requestUrl.pathname);
  if (route) {
    if (!route.methods.includes(request.method)) {
      response.writeHead(405, { Allow: route.methods.join(", ") });
      response.end();
      return;
    }
    void proxyApi(request, response, route, requestUrl.search);
    return;
  }

  if (requestUrl.pathname.startsWith("/api/")) {
    sendJson(response, 404, { message: "Rota da dashboard não encontrada." });
    return;
  }

  serveStatic(request, response, requestUrl.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Dashboard local em http://${HOST}:${PORT}`);
});

server.on("error", error => {
  console.error(`Não foi possível iniciar a dashboard: ${error.message}`);
  process.exitCode = 1;
});
