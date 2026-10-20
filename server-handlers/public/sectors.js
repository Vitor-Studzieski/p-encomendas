"use strict";

const { fail, json, methodNotAllowed } = require("../../lib/http");
const { getActiveSectors } = require("../../lib/supabase");

module.exports = async function publicSectors(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  try {
    const data = await getActiveSectors();
    return json(response, 200, { data: (data || []).map(({ id, name, slug }) => ({ id, name, slug })) });
  } catch (error) {
    return fail(response, error, "Não foi possível carregar os setores de produção.");
  }
};
