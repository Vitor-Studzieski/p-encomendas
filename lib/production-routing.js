"use strict";

const ROUTE_PRIORITY = ["bakery", "confectionery", "butcher", "cold_cuts", "rotisserie", "other"];
const ROUTE_SETTINGS = {
  bakery: "bakery_phone_e164",
  confectionery: "confectionery_phone_e164",
  butcher: "butcher_phone_e164",
  cold_cuts: "cold_cuts_phone_e164",
  rotisserie: "rotisserie_phone_e164"
};

function firstRecord(value) {
  if (Array.isArray(value)) return value[0] || {};
  return value && typeof value === "object" ? value : {};
}

function itemSector(item, sectorById) {
  const related = firstRecord(item?.sector);
  const id = item?.sector_id || related.id || "";
  const sector = sectorById?.get(String(id)) || related;
  const name = sector.name || item?.sector_name || (typeof item?.sector === "string" ? item.sector : "") || "Setor";
  return { id, name, slug: sector.slug || "" };
}

function productionRouteKey(sector) {
  const routeLabel = [sector?.slug, sector?.name, sector?.sector]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR");
  if (/padaria|bakery/.test(routeLabel)) return "bakery";
  if (/confeitaria|confectionery/.test(routeLabel)) return "confectionery";
  if (/acougue|butcher/.test(routeLabel)) return "butcher";
  if (/frios|cold.?cuts/.test(routeLabel)) return "cold_cuts";
  if (/rotisseria|rotisserie/.test(routeLabel)) return "rotisserie";
  return "other";
}

function groupProductionItems(items, sectors = []) {
  const sectorById = new Map((sectors || []).map(sector => [String(sector.id), sector]));
  const routes = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const sector = itemSector(item, sectorById);
    const routeKey = productionRouteKey(sector);
    if (!routes.has(routeKey)) routes.set(routeKey, { sectorNames: new Set(), items: [] });
    const route = routes.get(routeKey);
    route.sectorNames.add(sector.name);
    route.items.push(item);
  }
  return routes;
}

function leadProductionRouteKey(items, sectors = []) {
  const routes = items instanceof Map ? items : groupProductionItems(items, sectors);
  return ROUTE_PRIORITY.find(routeKey => routes.has(routeKey)) || "";
}

function productionPhone(settings, routeKey) {
  const key = ROUTE_SETTINGS[routeKey];
  if (!key) return "";
  return settings?.[key] || "";
}

function productionRouteLabel(route, fallback = "Setor de produção") {
  return route?.sectorNames instanceof Set && route.sectorNames.size
    ? Array.from(route.sectorNames).join(", ")
    : fallback;
}

module.exports = { ROUTE_PRIORITY, ROUTE_SETTINGS, groupProductionItems, leadProductionRouteKey, productionPhone, productionRouteKey, productionRouteLabel };
