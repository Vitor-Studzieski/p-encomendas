"use strict";

function firstRecord(value) {
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === "object" ? value : {};
}

function formatOrderItems(items) {
  if (!Array.isArray(items)) return "";
  return items.map(item => {
    const product = firstRecord(item?.product);
    const productSize = firstRecord(item?.product_size);
    const name = [item?.name, item?.product_name, product.name]
      .find(value => typeof value === "string" && value.trim()) || "Item";
    const size = [item?.size_label, productSize.label]
      .find(value => typeof value === "string" && value.trim()) || "";
    const quantity = item?.quantity ?? 1;
    return String(quantity) + "× " + String(name) + (size ? " · " + String(size).trim() : "");
  }).join("\n");
}

module.exports = { formatOrderItems };
