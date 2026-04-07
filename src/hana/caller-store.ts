import { AsyncLocalStorage } from "node:async_hooks";
import type { CallerContext } from "../server/context.js";

export const callerStore = new AsyncLocalStorage<CallerContext>();
