"use strict";

async function runNodeHandler(nodeHandler, event) {
  const request = event.node.req;
  const state = {
    status: 200,
    headers: {},
    body: "",
    ended: false
  };
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader(name, value) {
      state.headers[name] = String(value);
      return this;
    },
    status(code) {
      state.status = code;
      this.statusCode = code;
      return this;
    },
    json(payload) {
      state.body = JSON.stringify(payload);
      state.headers["Content-Type"] = state.headers["Content-Type"] || "application/json; charset=utf-8";
      state.ended = true;
      this.headersSent = true;
      return this;
    },
    writeHead(code, headers = {}) {
      state.status = code;
      this.statusCode = code;
      Object.assign(state.headers, headers);
      this.headersSent = true;
      return this;
    },
    end(body = "") {
      if (body !== undefined && body !== null) state.body = Buffer.isBuffer(body) ? body : String(body);
      state.ended = true;
      return this;
    }
  };

  await nodeHandler(request, response);
  if (!state.ended) state.ended = true;
  return new Response(state.body || null, {
    status: state.status || response.statusCode || 200,
    headers: state.headers
  });
}

export { runNodeHandler };

