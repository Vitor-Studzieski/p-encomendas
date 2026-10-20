import { defineHandler } from "nitro";
import { runNodeHandler } from "../../../lib/nitro-adapter.js";
import nodeHandler from "../../../server-handlers/public/sectors.js";

export default defineHandler(event => runNodeHandler(nodeHandler, event));
