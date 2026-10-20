import { escapeHtml } from "../dashboard/domain/orders.js";

export async function mountOrderItems(container) {
  if (!container) throw new Error("Área de itens do pedido não encontrada.");
  const list = container.querySelector("[data-item-list]");
  const addButton = container.querySelector("[data-add-item]");
  const status = container.querySelector("[data-item-status]");
  const response = await fetch("/api/public/sectors", { headers: { Accept: "application/json" }, cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "Não foi possível carregar os setores.");
  const sectors = Array.isArray(payload?.data) ? payload.data : [];
  if (!sectors.length) throw new Error("Não há setores ativos para atribuir aos itens.");
  const departmentFor = sector => {
    const normalized = [sector.slug, sector.name].filter(Boolean).join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
    return /acougue|butcher/.test(normalized) ? "Açougue" : /frios|cold.?cuts/.test(normalized) ? "Frios" : "Padaria";
  };
  const options = '<option value="">Selecione o setor do produto</option>' + ["Padaria", "Açougue", "Frios"].map(department => {
    const group = sectors.filter(sector => departmentFor(sector) === department);
    return group.length ? '<optgroup label="' + department + '">' + group.map(sector => '<option value="' + escapeHtml(sector.id) + '" data-sector-name="' + escapeHtml(sector.name) + '">' + escapeHtml(sector.name) + "</option>").join("") + "</optgroup>" : "";
  }).join("");
  let rowNumber = 0;

  function addRow() {
    rowNumber += 1;
    const row = document.createElement("div");
    row.className = "order-item-row";
    row.innerHTML = '<label class="field item-name-field"><span>Produto ' + rowNumber + '</span><input data-item-name maxlength="160" placeholder="Ex.: pão de queijo" required></label>' +
      '<label class="field item-quantity-field"><span>Quantidade</span><input data-item-quantity type="number" min="0.01" max="999" step="0.01" value="1" required></label>' +
      '<label class="field item-sector-field"><span>Setor</span><select data-item-sector required>' + options + '</select></label>' +
      '<button class="item-remove-button" type="button" aria-label="Remover produto ' + rowNumber + '" title="Remover produto">×</button>';
    row.querySelector(".item-remove-button").addEventListener("click", () => {
      if (list.children.length === 1) {
        row.querySelector("[data-item-name]").value = "";
        row.querySelector("[data-item-quantity]").value = "1";
        row.querySelector("[data-item-sector]").value = "";
      } else row.remove();
    });
    list.append(row);
  }

  function getItems() {
    const rows = Array.from(list.querySelectorAll(".order-item-row"));
    const items = rows.map(row => {
      const name = row.querySelector("[data-item-name]").value.trim();
      const quantity = Number(row.querySelector("[data-item-quantity]").value);
      const sectorSelect = row.querySelector("[data-item-sector]");
      const sectorOption = sectorSelect.selectedOptions[0];
      if (!name || !Number.isFinite(quantity) || quantity <= 0 || quantity > 999 || !sectorSelect.value) {
        throw new Error("Preencha produto, quantidade e setor em cada linha.");
      }
      return { name, quantity, sector_id: sectorSelect.value, sector: sectorOption?.dataset.sectorName || sectorOption?.textContent || "" };
    });
    if (!items.length || items.length > 50) throw new Error("Adicione de 1 a 50 produtos ao pedido.");
    return items;
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
  });
  addRow();
  return { getItems, reset, sectors };
}
