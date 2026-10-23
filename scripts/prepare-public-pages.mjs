import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const publicRoot = resolve(root, "public");

const publicFiles = [
  ["dashboard.html", "dashboard.html"],
  ["pedido.html", "pedido.html"],
  ["avaliacao.html", "avaliacao.html"],
  ["setor.html", "setor.html"],
  ["contas-setores.html", "contas-setores.html"],
  ["src/dashboard/dashboard.css", "src/dashboard/dashboard.css"],
  ["src/dashboard/config.js", "src/dashboard/config.js"],
  ["src/dashboard/app.js", "src/dashboard/app.js"],
  ["src/dashboard/domain/orders.js", "src/dashboard/domain/orders.js"],
  ["src/dashboard/ui/agenda.js", "src/dashboard/ui/agenda.js"],
  ["src/dashboard/ui/order-list.js", "src/dashboard/ui/order-list.js"],
  ["src/shared/styles.css", "src/shared/styles.css"],
  ["src/forms/forms.css", "src/forms/forms.css"],
  ["src/orders/order-form.js", "src/orders/order-form.js"],
  ["src/orders/catalog-order-items.js", "src/orders/catalog-order-items.js"],
  ["src/shared/order-items.js", "src/shared/order-items.js"],
  ["src/shared/idempotency.js", "src/shared/idempotency.js"],
  ["src/dashboard/domain/orders.js", "src/dashboard/domain/orders.js"],
  ["src/surveys/satisfaction-form.js", "src/surveys/satisfaction-form.js"],
  ["src/sector/portal.css", "src/sector/portal.css"],
  ["src/sector/portal.js", "src/sector/portal.js"],
  ["src/sector/accounts.css", "src/sector/accounts.css"],
  ["src/sector/accounts.js", "src/sector/accounts.js"]
];

for (const [source, destination] of publicFiles) {
  const outputPath = resolve(publicRoot, destination);
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(resolve(root, source), outputPath);
}
