import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const publicRoot = resolve(root, "public");

const publicFiles = [
  ["pedido.html", "pedido.html"],
  ["avaliacao.html", "avaliacao.html"],
  ["src/shared/styles.css", "src/shared/styles.css"],
  ["src/forms/forms.css", "src/forms/forms.css"],
  ["src/orders/order-form.js", "src/orders/order-form.js"],
  ["src/surveys/satisfaction-form.js", "src/surveys/satisfaction-form.js"]
];

for (const [source, destination] of publicFiles) {
  const outputPath = resolve(publicRoot, destination);
  await mkdir(dirname(outputPath), { recursive: true });
  await copyFile(resolve(root, source), outputPath);
}
