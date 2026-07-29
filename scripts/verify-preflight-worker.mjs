import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const mainUrl = new URL("../desktop/main.cjs", import.meta.url);
const workerUrl = new URL("../desktop/preflight-worker.cjs", import.meta.url);
const source = await readFile(mainUrl, "utf8");

await access(workerUrl);
assert.match(source, /function runStartupCheckWorker\(/, "main process must expose a preflight worker runner");
assert.doesNotMatch(
  source,
  /settings\.buildStartupCheck\(/,
  "Electron main process must not run synchronous startup checks directly",
);
assert.match(
  source,
  /ipcMain\.handle\("startup:check",[\s\S]*?await runStartupCheckWorker\(/,
  "manual startup checks must run in the worker",
);
assert.match(
  source,
  /const startupCheck = includePreflightDetail\s*\? await runStartupCheckWorker\(\)\s*:\s*null;[\s\S]*?\n\s*startupCheck,/,
  "preflight detail state must use the worker result",
);

console.log("Preflight worker isolation verification passed.");
