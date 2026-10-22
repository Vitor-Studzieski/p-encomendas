// Public route names only. All credentials stay in the server environment.
window.ORDER_DASHBOARD_CONFIG = Object.freeze({
  authEndpoint: "/api/auth/session",
  ordersEndpoint: "/api/orders",
  settingsEndpoint: "/api/settings",
  ordersClearEndpoint: "/api/orders/clear",
  orderActionEndpoint: "/api/order-actions",
  createOrderEndpoint: "/api/orders/create",
  productionAgendaEndpoint: "/api/production-agenda"
});
