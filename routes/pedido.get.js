import { defineHandler } from "nitro";

export default defineHandler(event => {
  const requestUrl = new URL(event.node.req.url || "/", "http://localhost");
  return new Response(null, {
    status: 302,
    headers: { "Cache-Control": "no-store", Location: "/pedido.html" + requestUrl.search }
  });
});

