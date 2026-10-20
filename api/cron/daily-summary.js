"use strict";

const { fail, json, methodNotAllowed, requireCron } = require("../../lib/http");
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

module.exports = async function dailySummary(request, response) {
  if (request.method !== "GET") return methodNotAllowed(response, ["GET"]);
  if (!requireCron(request, response)) return;
  let jobKey = "";
  try {
    const today = localDateParts();
    jobKey = "daily-summary:" + today;
    const tomorrow = addDays(today, 1);
    const [settings, orders] = await Promise.all([getOperationSettings(), getSummaryOrders(today, tomorrow)]);
    if (!settings.bakery_phone_e164) return json(response, 200, { ok: true, sent: false, reason: "Telefone da padaria não cadastrado." });
    const claimed = await claimAutomationRun(jobKey, "daily_summary", today);
    if (!claimed) return json(response, 200, { ok: true, sent: false, already_sent: true });

    const grouped = new Map([[today, []], [tomorrow, []]]);
    for (const order of orders || []) {
      const date = String(order.requested_date || "");
      if (grouped.has(date)) grouped.get(date).push(order);
    }
    const lines = ["Resumo da produção — " + today + " e " + tomorrow];
    for (const [date, rows] of grouped) {
      lines.push("", date === today ? "HOJE" : "AMANHÃ");
      if (!rows.length) {
        lines.push("Nenhum pedido ativo.");
        continue;
      }
      for (const order of rows) {
        lines.push(
          (order.requested_time || "horário a combinar") + " · " +
          (order.display_id || "Pedido") + " · " +
          (order.status || "status pendente") + " · " +
          (order.sector_name || "setor não informado"),
          order.items_summary || "Itens não informados"
        );
      }
    }
    await sendText(settings.bakery_phone_e164, lines.join("\n"));
    await updateAutomationRun(jobKey, "sent", { count: (orders || []).length });
    return json(response, 200, { ok: true, sent: true, orders: (orders || []).length });
  } catch (error) {
    if (jobKey) {
      try { await updateAutomationRun(jobKey, "failed", { reason: error.message }); }
      catch { /* Return the original error. */ }
    }
    return fail(response, error, "Não foi possível enviar o resumo diário.");
  }
};

