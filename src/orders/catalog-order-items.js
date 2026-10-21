"use strict";

function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function mountOrderItems(container, { access, expires } = {}) {
  if (!container) throw new Error("Área de itens do pedido não encontrada.");
  const list = container.querySelector("[data-item-list]");
  const addButton = container.querySelector("[data-add-item]");
  const status = container.querySelector("[data-item-status]");
  const response = await fetch("/api/public/order-catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    cache: "no-store",
    body: JSON.stringify({ acesso: access, expira: expires })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "Não foi possível carregar os produtos do catálogo.");

  const products = Array.isArray(payload?.data?.products) ? payload.data.products : [];
  const sector = payload?.data?.sector;
  if (!sector?.id || !sector?.name) throw new Error("O setor Confeitaria não está ativo no catálogo.");
  if (!products.length) throw new Error("Não há produtos ativos no catálogo.");

  const labelCounts = new Map();
  for (const product of products) {
    const base = String(product.name || "").trim() + (product.category ? " · " + String(product.category).trim() : "");
    labelCounts.set(base, (labelCounts.get(base) || 0) + 1);
  }
  const productLabels = new Map(products.map(product => {
    const base = String(product.name || "").trim() + (product.category ? " · " + String(product.category).trim() : "");
    return [labelCounts.get(base) > 1 ? base + " · " + String(product.id).slice(0, 8) : base, product];
  }));
  let rowNumber = 0;

  function closeSuggestions(row) {
    const options = row.querySelector("[data-product-options]");
    options.hidden = true;
    options.replaceChildren();
    row.querySelector("[data-item-name]").setAttribute("aria-expanded", "false");
    row.dataset.activeOption = "-1";
  }

  function setSizeOptions(row, product, selectedId = "") {
    const select = row.querySelector("[data-item-size]");
    const options = Array.isArray(product?.sizes) ? product.sizes : [];
    select.replaceChildren();
    select.required = options.length > 1;

    if (!product) {
      select.disabled = true;
      select.append(new Option("Selecione um produto", ""));
      return;
    }
    if (!options.length) {
      select.disabled = true;
      select.append(new Option("Sem tamanho cadastrado", ""));
      return;
    }

    select.disabled = false;
    if (options.length > 1) select.append(new Option("Escolha o tamanho", ""));
    for (const size of options) {
      const option = new Option(String(size.label), String(size.id));
      option.dataset.label = String(size.label);
      select.append(option);
    }
    select.value = selectedId || (options.length === 1 ? String(options[0].id) : "");
  }

  function chooseProduct(row, product, label) {
    const input = row.querySelector("[data-item-name]");
    input.value = label;
    row.dataset.productId = String(product.id);
    row.querySelector("[data-item-size]").setAttribute("aria-label", "Tamanho de " + product.name);
    setSizeOptions(row, product);
    closeSuggestions(row);
    input.focus();
    status.textContent = "";
  }

  function showSuggestions(row) {
    const input = row.querySelector("[data-item-name]");
    const optionsPanel = row.querySelector("[data-product-options]");
    const query = normalizeSearch(input.value);
    row.dataset.activeOption = "-1";
    optionsPanel.replaceChildren();
    if (!query) {
      optionsPanel.hidden = true;
      input.setAttribute("aria-expanded", "false");
      return;
    }

    const queryTokens = query.split(/\s+/).filter(Boolean);
    const matches = products.filter(product => {
      const searchable = normalizeSearch([product.name, product.category].filter(Boolean).join(" "));
      return queryTokens.every(token => searchable.includes(token));
    }).slice(0, 8);

    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "item-product-option-empty";
      empty.textContent = "Nenhum produto encontrado no catálogo.";
      optionsPanel.append(empty);
    } else {
      for (const product of matches) {
        const label = Array.from(productLabels.entries()).find(([, value]) => value.id === product.id)?.[0] || String(product.name);
        const option = document.createElement("button");
        option.type = "button";
        option.className = "item-product-option";
        option.setAttribute("role", "option");
        const productName = document.createElement("strong");
        productName.textContent = label;
        option.append(productName);
        const sizeLabels = (Array.isArray(product.sizes) ? product.sizes : []).map(size => String(size.label || "")).filter(Boolean);
        if (sizeLabels.length) {
          const sizes = document.createElement("small");
          sizes.textContent = "Tamanhos: " + sizeLabels.join(", ");
          option.append(sizes);
        }
        option.addEventListener("click", () => chooseProduct(row, product, label));
        optionsPanel.append(option);
      }
    }
    optionsPanel.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function addRow() {
    rowNumber += 1;
    const row = document.createElement("div");
    row.className = "order-item-row";
    row.innerHTML = '<div class="field item-name-field"><span id="item-product-label-' + rowNumber + '">Produto ' + rowNumber + '</span><input id="item-product-' + rowNumber + '" data-item-name type="search" maxlength="180" placeholder="Digite para buscar no catálogo" autocomplete="off" role="combobox" aria-labelledby="item-product-label-' + rowNumber + '" aria-controls="item-product-options-' + rowNumber + '" aria-autocomplete="list" aria-expanded="false" required><div class="item-product-options" id="item-product-options-' + rowNumber + '" data-product-options role="listbox" hidden></div></div>' +
      '<label class="field item-size-field"><span>Tamanho</span><select data-item-size required disabled><option value="">Selecione um produto</option></select></label>' +
      '<label class="field item-quantity-field"><span>Quantidade</span><input data-item-quantity type="number" min="0.01" max="999" step="0.01" value="1" required></label>' +
      '<button class="item-remove-button" type="button" aria-label="Remover produto ' + rowNumber + '" title="Remover produto">×</button>';

    const input = row.querySelector("[data-item-name]");
    input.addEventListener("input", () => {
      row.dataset.productId = "";
      setSizeOptions(row, null);
      showSuggestions(row);
    });
    input.addEventListener("focus", () => {
      if (!row.dataset.productId) showSuggestions(row);
    });
    input.addEventListener("keydown", event => {
      const optionButtons = Array.from(row.querySelectorAll(".item-product-option"));
      let active = Number(row.dataset.activeOption || -1);
      if (event.key === "ArrowDown" && optionButtons.length) {
        event.preventDefault();
        active = Math.min(active + 1, optionButtons.length - 1);
        row.dataset.activeOption = String(active);
        optionButtons.forEach((button, index) => button.setAttribute("aria-selected", String(index === active)));
      } else if (event.key === "ArrowUp" && optionButtons.length) {
        event.preventDefault();
        active = Math.max(active - 1, 0);
        row.dataset.activeOption = String(active);
        optionButtons.forEach((button, index) => button.setAttribute("aria-selected", String(index === active)));
      } else if (event.key === "Enter" && active >= 0 && optionButtons[active]) {
        event.preventDefault();
        optionButtons[active].click();
      } else if (event.key === "Escape") {
        closeSuggestions(row);
      }
    });
    row.querySelector("[data-item-size]").addEventListener("change", () => {
      if (row.querySelector("[data-item-size]").value) status.textContent = "";
    });
    row.querySelector(".item-remove-button").addEventListener("click", () => {
      if (list.children.length === 1) {
        row.querySelector("[data-item-name]").value = "";
        row.dataset.productId = "";
        row.querySelector("[data-item-quantity]").value = "1";
        setSizeOptions(row, null);
        closeSuggestions(row);
      } else row.remove();
    });
    list.append(row);
  }

  function getItems() {
    const rows = Array.from(list.querySelectorAll(".order-item-row"));
    const items = rows.map((row, index) => {
      const product = products.find(entry => String(entry.id) === row.dataset.productId);
      const quantity = Number(row.querySelector("[data-item-quantity]").value);
      if (!product) throw new Error(`Escolha um produto da lista na linha ${index + 1}.`);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) {
        throw new Error(`Informe uma quantidade entre 0,01 e 999 para “${product.name}”.`);
      }

      const sizeSelect = row.querySelector("[data-item-size]");
      const sizes = Array.isArray(product.sizes) ? product.sizes : [];
      const size = sizes.find(entry => String(entry.id) === sizeSelect.value);
      if (sizes.length && !size) throw new Error(`Escolha um tamanho disponível para “${product.name}”.`);

      return {
        product_id: product.id,
        name: product.name,
        quantity,
        unit: product.unit || "un",
        ...(size ? { product_size_id: size.id, size_label: size.label } : {}),
        sector_id: sector.id,
        sector: sector.name
      };
    });
    if (!items.length || items.length > 50) throw new Error("Adicione de 1 a 50 produtos ao pedido.");
    return items;
  }

  function setDisabled(disabled) {
    container.querySelectorAll("[data-item-name], [data-item-quantity], [data-item-size], [data-add-item], .item-remove-button").forEach(control => {
      control.disabled = Boolean(disabled);
    });
  }

  function reset() {
    list.replaceChildren();
    rowNumber = 0;
    addRow();
    if (status) status.textContent = "";
  }

  addButton?.addEventListener("click", () => {
    if (list.children.length >= 50) {
      if (status) status.textContent = "O pedido pode ter no máximo 50 produtos.";
      return;
    }
    addRow();
    list.lastElementChild.querySelector("[data-item-name]").focus();
  });

  reset();
  return { getItems, reset, setDisabled, sector };
}
