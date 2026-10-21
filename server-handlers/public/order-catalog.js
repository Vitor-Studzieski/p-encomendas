"use strict";

const { enforceRateLimit, fail, json, methodNotAllowed, readBody } = require("../../lib/http");
const { getActiveProducts, getActiveSectors } = require("../../lib/supabase");
const { verifyPublicFormToken } = require("../../lib/public-form-token");

module.exports = async function publicOrderCatalog(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!process.env.PUBLIC_ORDER_FORM_TOKEN || process.env.PUBLIC_ORDER_FORM_TOKEN.length < 32) {
    return json(response, 503, { message: "Formulário público ainda não configurado." });
  }

  try {
    if (!await enforceRateLimit(request, response, "public-order-catalog", 60, 10 * 60)) return;
    const body = await readBody(request);
    if (!verifyPublicFormToken(body.acesso, body.expira)) {
      return json(response, 401, { message: "Link do formulário inválido ou expirado." });
    }

    const [products, sectors] = await Promise.all([getActiveProducts(), getActiveSectors()]);
    const sector = (sectors || []).find(item => String(item.slug || "").toLowerCase() === "confeitaria");
    if (!sector) return json(response, 503, { message: "O setor Confeitaria não está ativo no catálogo." });

    const data = (products || []).map(product => ({
      id: product.id,
      name: product.name,
      category: product.category || "",
      unit: product.unit || "un",
      sizes: (Array.isArray(product.sizes) ? product.sizes : [])
        .filter(size => size && size.active !== false && size.id && size.label)
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
        .map(size => ({ id: size.id, label: String(size.label).trim() }))
    }));

    return json(response, 200, {
      data: {
        products: data,
        sector: { id: sector.id, name: sector.name, slug: sector.slug }
      }
    });
  } catch (error) {
    return fail(response, error, "Não foi possível carregar o catálogo de produtos.");
  }
};
