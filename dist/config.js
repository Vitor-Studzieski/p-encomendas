// A dashboard fala apenas com o proxy local. O proxy encaminha as rotas ao n8n
// e entrega o token somente em memória durante esta sessão do navegador.
window.ORDER_DASHBOARD_CONFIG = Object.freeze({
  ordersEndpoint: "/api/orders",
  settingsEndpoint: "/api/settings",
  orderActionEndpoint: "/api/order-actions",
  createOrderEndpoint: "/api/orders/create"
});
