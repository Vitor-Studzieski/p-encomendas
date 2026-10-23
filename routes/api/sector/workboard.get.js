import { defineHandler } from "nitro";
import { runNodeHandler } from "../../../lib/nitro-adapter.js";
import nodeHandler from "../../../server-handlers/sector/workboard.js";

export default defineHandler(event => runNodeHandler(nodeHandler, event));
