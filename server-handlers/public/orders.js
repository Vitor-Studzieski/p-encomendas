"use strict";

const { createOrderEvent, dispatchEvent } = require("../../lib/events");
const { enforceRateLimit, fail, json, methodNotAllowed, readBody } = require("../../lib/http");
const { getActiveProducts, getActiveSectors, getOperationSettings } = require("../../lib/supabase");
const { verifyPublicFormToken } = require("../../lib/public-form-token");

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidOrder(message) {
  return Object.assign(new Error(message), { statusCode: 422 });
}

function normalizeCatalogItems(items, products, sector) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    throw invalidOrder("Adicione de 1 a 50 produtos do catálogo.");
  }

  const byId = new Map((products || []).map(product => [String(product.id), product]));
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidOrder(`O produto ${index + 1} não é válido.`);
    }

    const productId = String(item.product_id || item.id || "");
    const product = uuidPattern.test(productId) ? byId.get(productId) : null;
    if (!product) throw invalidOrder(`Escolha um produto ativo do catálogo na linha ${index + 1}.`);

    const quantity = Number(item.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) {
      throw invalidOrder(`Informe uma quantidade entre 0,01 e 999 para “${product.name}”.`);
    }

    const sizes = (Array.isArray(product.sizes) ? product.sizes : [])
      .filter(size => size && size.active !== false && size.id && size.label)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
    const requestedSizeId = String(item.product_size_id || item.size_id || "");
    const requestedLabel = String(item.size_label || item.size || "").trim();
    let selectedSize = null;

    if (sizes.length) {
      if (requestedSizeId) {
        selectedSize = uuidPattern.test(requestedSizeId)
          ? sizes.find(size => String(size.id) === requestedSizeId)
          : null;
        if (!selectedSize) throw invalidOrder(`O tamanho escolhido para “${product.name}” não está mais disponível. Atualize a página e escolha novamente.`);
        if (requestedLabel && requestedLabel !== String(selectedSize.label).trim()) {
          throw invalidOrder(`O tamanho escolhido para “${product.name}” mudou no catálogo. Atualize a página e escolha novamente.`);
        }
      } else if (requestedLabel) {
        const matches = sizes.filter(size => String(size.label).trim() === requestedLabel);
        if (matches.length === 1) selectedSize = matches[0];
        else throw invalidOrder(`Escolha um tamanho disponível para “${product.name}”.`);
      } else if (sizes.length === 1) {
        selectedSize = sizes[0];
      } else {
        throw invalidOrder(`Escolha um dos tamanhos disponíveis para “${product.name}”.`);
      }
    } else if (requestedSizeId || requestedLabel) {
      throw invalidOrder(`“${product.name}” não possui tamanho cadastrado. Atualize a página e revise o pedido.`);
    }

    return {
      product_id: product.id,
      name: product.name,
      quantity,
      unit: product.unit || "un",
      ...(selectedSize ? { product_size_id: selectedSize.id, size_label: String(selectedSize.label).trim() } : {}),
      sector_id: sector.id,
      sector: sector.name
    };
  });
}

module.exports = async function publicOrders(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, ["POST"]);
  if (!process.env.PUBLIC_ORDER_FORM_TOKEN || process.env.PUBLIC_ORDER_FORM_TOKEN.length < 32) {
    return json(response, 503, { message: "Formulário público ainda não configurado." });
  }
  try {
    if (!await enforceRateLimit(request, response, "public-order-form", 10, 10 * 60)) return;
    const body = await readBody(request);
    if (!verifyPublicFormToken(body.acesso, body.expira)) return json(response, 401, { message: "Link do formulário inválido ou expirado." });
    const [settings, products, sectors] = await Promise.all([
      getOperationSettings(),
      getActiveProducts(),
      getActiveSectors()
    ]);
    const confectionerySector = (sectors || []).find(sector => String(sector.slug || "").toLowerCase() === "confeitaria");
    if (!confectionerySector) throw Object.assign(new Error("O setor Confeitaria não está ativo no catálogo."), { statusCode: 503 });
    const items = normalizeCatalogItems(body.items, products, confectionerySector);

    const event = createOrderEvent({
      event_id: body.event_id,
      order_ref: body.order_ref,
      payload: {
        order: {
          requested_date: body.requested_date,
          requested_time: body.requested_time,
          pickup_location: body.pickup_location,
          fulfillment_type: "pickup",
          notes: body.notes
        },
        customer: { name: body.customer_name, phone_e164: body.customer_phone },
        fiscal: { phone_e164: settings.fiscal_phone_e164 },
        items
      }
    });
    const result = await dispatchEvent(event, { settings });
    return json(response, 202, { ok: true, order_ref: event.order_ref, warnings: result.warnings });
  } catch (error) {
    return fail(response, error, "Não foi possível enviar a encomenda.");
  }
};

