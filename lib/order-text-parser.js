"use strict";

const ignoredTokens = new Set([
  "de", "da", "do", "das", "dos", "a", "o", "as", "os", "e", "com", "para", "pra", "em",
  "por", "favor", "quero", "queria", "gostaria", "preciso", "manda", "mandar", "mande", "envia",
  "enviar", "adiciona", "adicione", "coloca", "coloque", "pedido", "pedidos", "produto", "produtos",
  "item", "itens", "retirada", "retirar", "amanha", "hoje", "un", "und", "unidade", "unidades", "unid",
  "caixa", "caixas", "pacote", "pacotes", "aproximadamente", "pessoa", "pessoas"
]);

const tokenAliases = Object.freeze({
  paes: "pao",
  pao: "pao",
  paoes: "pao",
  paesinho: "pao",
  baguetes: "baguete",
  bolos: "bolo",
  esfihas: "esfirra",
  esfiha: "esfirra",
  esfirras: "esfirra",
  franceses: "frances",
  hamburgueres: "hamburguer",
  queijos: "queijo",
  lanches: "lanche",
  frios: "frio",
  presunto: "pres",
  presuntos: "pres",
  qjo: "queijo",
  sanduiche: "lanche",
  sanduiches: "lanche",
  conf: "confeitado",
  c: "com",
  gergelim: "gergilim",
  sonho: "s",
  tres: "tres"
});

const numberWords = Object.freeze({ um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 });
const preamblePattern = /^(?:(?:por favor|eu quero|quero|queria|gostaria de|preciso de|me envie|manda|mande|adiciona|adicione|coloca|coloque)(?:\s+|$))+/i;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/(\d)[,.](\d)/g, "$1p$2")
    .replace(/(\d)\s+(kg|g)\b/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .map(token => tokenAliases[token] || token)
    .filter(token => token && !ignoredTokens.has(token));
}

function splitSegments(value) {
  const protectedDecimals = String(value || "").replace(/(\d),(\d)/g, "$1\u0000$2");
  return protectedDecimals
    .split(/[\r\n;]+|,|\s+e\s+(?=(?:\d+(?:[.,]\d+)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\b)/i)
    .map(segment => segment.replace(/\u0000/g, ",").trim())
    .filter(Boolean);
}

function parseQuantity(segment) {
  let rest = normalizeText(segment).replace(preamblePattern, "").trim();
  let quantity = 1;
  let consumed = 0;
  const dozen = rest.match(/^(?:meia|uma)\s+duzia\b/i);
  if (dozen) {
    quantity = dozen[0].startsWith("meia") ? 6 : 12;
    consumed = dozen[0].length;
  } else {
    const match = rest.match(/^(\d{1,3}(?:p\d+)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\b/i);
    if (match) {
      quantity = Object.hasOwn(numberWords, match[1]) ? numberWords[match[1]] : Number(match[1].replace("p", "."));
      consumed = match[0].length;
    }
  }
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) {
    return { error: "Use uma quantidade entre 1 e 999." };
  }
  rest = rest.slice(consumed).replace(/^\s*(?:x|de|do|da|dos|das|un|und|unid|unidade|unidades|caixa|caixas|pacote|pacotes)\b\s*/i, "").trim();
  return { quantity, productText: rest };
}

function productTokens(product) {
  return new Set(tokenize([
    product.name,
    product.category,
    ...productSizeLabels(product)
  ].filter(Boolean).join(" ")));
}

function productSizeLabels(product) {
  return productSizeOptions(product).map(size => size.label);
}

function productSizeOptions(product) {
  return (Array.isArray(product?.sizes) ? product.sizes : [])
    .filter(size => size && size.active !== false && typeof size.label === "string" && size.label.trim())
    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
    .map(size => ({ id: size.id, label: size.label.trim() }));
}

function productIdentityTokens(product) {
  const sizeTokens = new Set(productSizeLabels(product).flatMap(tokenize));
  return new Set(tokenize([product.name, product.category].filter(Boolean).join(" "))
    .filter(token => !sizeTokens.has(token)));
}

function resolveSizeLabel(product, productText) {
  const sizes = productSizeOptions(product);
  if (!sizes.length) return "";
  const requestTokens = new Set(tokenize(productText));
  const mentioned = sizes.filter(size => {
    const sizeTokens = tokenize(size.label);
    return sizeTokens.length > 0 && sizeTokens.every(token => requestTokens.has(token));
  });
  if (mentioned.length === 1) return mentioned[0];
  if (sizes.length === 1) return sizes[0];
  if (mentioned.length > 1) {
    throw Object.assign(new Error(`Escolha apenas um tamanho para “${product.name}”: ${sizes.map(size => size.label).join(" ou ")}.`), { statusCode: 422 });
  }
  return "";
}

function explainUnmatched(segment) {
  return `Não encontrei um produto parecido com “${segment}”. Tente descrever o produto com mais detalhes; não precisa copiar o nome inteiro do catálogo.`;
}

function resolveOrderText(value, products, confectionerySector) {
  const text = String(value || "").trim();
  if (!text) throw Object.assign(new Error("Descreva os produtos e as quantidades para identificar o pedido."), { statusCode: 422 });
  if (text.length > 3000) throw Object.assign(new Error("O pedido em texto pode ter até 3.000 caracteres."), { statusCode: 422 });
  if (!confectionerySector?.id) {
    throw Object.assign(new Error("O setor Confeitaria ainda não está cadastrado como ativo."), { statusCode: 503 });
  }

  const itemsById = new Map();
  for (const segment of splitSegments(text)) {
    const { quantity, productText, error } = parseQuantity(segment);
    if (error) throw Object.assign(new Error(error), { statusCode: 422 });
    const queryTokens = Array.from(new Set(tokenize(productText)));
    if (!queryTokens.length) {
      if (!tokenize(segment.replace(preamblePattern, "")).length) continue;
      throw Object.assign(new Error(explainUnmatched(segment)), { statusCode: 422 });
    }

    let matches = products.filter(product => {
      const tokens = productTokens(product);
      return queryTokens.every(token => tokens.has(token));
    });

    if (!queryTokens.includes("mini") && matches.some(product => productTokens(product).has("mini"))) {
      const standardProducts = matches.filter(product => !productTokens(product).has("mini"));
      if (standardProducts.length) matches = standardProducts;
    }
    if (!queryTokens.includes("gergilim") && matches.some(product => productTokens(product).has("gergilim"))) {
      const plainProducts = matches.filter(product => !productTokens(product).has("gergilim"));
      if (plainProducts.length) matches = plainProducts;
    }

    if (!matches.length) throw Object.assign(new Error(explainUnmatched(segment)), { statusCode: 422 });
    const extraTokenCount = product => Array.from(productIdentityTokens(product)).filter(token => !queryTokens.includes(token)).length;
    const bestScore = Math.min(...matches.map(extraTokenCount));
    matches = matches.filter(product => extraTokenCount(product) === bestScore);
    if (matches.length > 1) {
      const options = matches.slice(0, 3).map(product => product.name).join(", ");
      throw Object.assign(new Error(`“${segment}” pode ser mais de um produto (${options}). Especifique qual deles.`), { statusCode: 422 });
    }

    const product = matches[0];
    const selectedSize = resolveSizeLabel(product, productText);
    const sizeLabel = selectedSize?.label || "";
    const itemKey = product.id + "::" + (selectedSize?.id || sizeLabel);
    const existing = itemsById.get(itemKey);
    const total = (existing?.quantity || 0) + quantity;
    if (total > 999) throw Object.assign(new Error(`A quantidade de “${product.name}” ultrapassa 999.`), { statusCode: 422 });
    itemsById.set(itemKey, {
      product_id: product.id,
      name: product.name,
      quantity: total,
      unit: product.unit || "un",
      ...(selectedSize?.id ? { product_size_id: selectedSize.id } : {}),
      ...(sizeLabel ? { size_label: sizeLabel } : {}),
      ...(productSizeOptions(product).length ? { available_sizes: productSizeOptions(product) } : {}),
      sector_id: confectionerySector.id,
      sector: confectionerySector.name
    });
    if (itemsById.size > 50) throw Object.assign(new Error("O pedido pode ter no máximo 50 produtos."), { statusCode: 422 });
  }
  if (!itemsById.size) throw Object.assign(new Error("Descreva pelo menos um produto do catálogo."), { statusCode: 422 });
  return Array.from(itemsById.values());
}

module.exports = { resolveOrderText };
