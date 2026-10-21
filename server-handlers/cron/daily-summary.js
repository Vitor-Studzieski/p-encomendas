"use strict";

const { fail, json, methodNotAllowed, requireCron } = require("../../lib/http");
const { formatOrderItems } = require("../../lib/order-items");
const { groupProductionItems, productionPhone, productionRouteLabel } = require("../../lib/production-routing");
const { claimAutomationRun, getOperationSettings, getSummaryOrders, updateAutomationRun } = require("../../lib/supabase");
const { sendText } = require("../../lib/zapi");

function localDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return values.year + "-" + values.month + "-" + values.day;
}

function addDays(date, amount) {
  const value = new Date(date + "T12:00:00-03:00");
  value.setDate(value.getDate() + amount);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function displayDate(date) {
  const match = String(date || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match[3] + "/" + match[2] + "/" + match[1] : String(date || "");
}

module.exports = async function dailySummary(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  if (!requireCron(request, response)) return;
  try {
    const today = localDateParts();
    const tomorrow = addDays(today, 1);
    const [settings, orders] = await Promise.all([getOperationSettings(), getSummaryOrders(today, tomorrow)]);
    const groupedByRoute = new Map();
    for (const order of orders || []) {
      const routeGroups = groupProductionItems(order.items);
      for (const [routeKey, route] of routeGroups) {
        const date = String(order.requested_date || "");
        if (![today, tomorrow].includes(date)) continue;
        if (!groupedByRoute.has(routeKey)) groupedByRoute.set(routeKey, new Map([[today, []], [tomorrow, []]]));
        groupedByRoute.get(routeKey).get(date).push({ order, route });
      }
    }
    if (!groupedByRoute.size) return json(response, 200, { ok: true, sent: false, reason: "Nenhum pedido ativo com setor de produção atribuído." });

    const sentRoutes = [];
    const missingRecipients = [];
    const alreadySentRoutes = [];
    const errors = [];
    for (const [routeKey, grouped] of groupedByRoute) {
      const phone = productionPhone(settings, routeKey);
      if (!phone) {
        missingRecipients.push(routeKey);
        continue;
      }
      const jobKey = "daily-summary:" + today + ":" + routeKey;
      try {
        if (!await claimAutomationRun(jobKey, "daily_summary", today)) {
          alreadySentRoutes.push(routeKey);
          continue;
        }
        const lines = ["Resumo da produção — " + displayDate(today) + " e " + displayDate(tomorrow)];
        for (const [date, rows] of grouped) {
          lines.push("", date === today ? "HOJE" : "AMANHÃ");
          if (!rows.length) {
            lines.push("Nenhum pedido ativo.");
            continue;
          }
          for (const { order, route } of rows) {
            const itemSummary = formatOrderItems(route.items) || "Itens não informados";
            lines.push(
              (order.requested_time || "horário a combinar") + " · " +
              (order.display_id || "Pedido") + " · " +
              (order.status || "status pendente") + " · " +
              productionRouteLabel(route),
              itemSummary
            );
          }
        }
        await sendText(phone, lines.join("\n"));
        await updateAutomationRun(jobKey, "sent", { count: grouped.get(today).length + grouped.get(tomorrow).length, route: routeKey });
        sentRoutes.push(routeKey);
      } catch (error) {
        errors.push(error);
        try { await updateAutomationRun(jobKey, "failed", { reason: error.message, route: routeKey }); }
        catch { /* Return the original error. */ }
      }
    }
    if (errors.length) throw errors[0];
    return json(response, 200, {
      ok: true,
      sent: sentRoutes.length > 0,
      sent_routes: sentRoutes,
      missing_recipients: missingRecipients,
      already_sent_routes: alreadySentRoutes
    });
  } catch (error) {
    return fail(response, error, "Não foi possível enviar o resumo diário.");
  }
};

