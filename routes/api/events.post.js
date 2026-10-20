import { defineHandler } from "nitro";
import { createRequire } from "node:module";
import { runNodeHandler } from "../../lib/nitro-adapter.js";

const require = createRequire(import.meta.url);
const nodeHandler = require("../../api/events.js");

export default defineHandler(event => runNodeHandler(nodeHandler, event));

