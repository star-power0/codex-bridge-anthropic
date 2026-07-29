const { parentPort, workerData } = require("node:worker_threads");

(async () => {
  try {
    const settings = await import("./settings.mjs");
    const rootDir = String(workerData?.rootDir || "").trim();
    const homeDir = String(workerData?.homeDir || "").trim() || undefined;
    const desktopOptions = settings.loadDesktopOptions(rootDir);
    const config = settings.readRouterConfig(rootDir);
    const { codexCliSnapshot, codexPromptInputSnapshot } =
      settings.readCodexResourceSnapshots({ desktopOptions, ...(homeDir ? { homeDir } : {}) });
    let releaseAssets = null;
    if (desktopOptions.acceptanceReleaseDir) {
      try {
        const assets = settings.releaseAssetsFromDirectory(desktopOptions.acceptanceReleaseDir);
        releaseAssets = assets.length ? assets : null;
      } catch {
        releaseAssets = null;
      }
    }
    const result = settings.buildStartupCheck(rootDir, {
      ...(homeDir ? { homeDir } : {}),
      appVersion: String(workerData?.appVersion || ""),
      routerRunning: Boolean(workerData?.routerRunning),
      lastHealth: workerData?.lastHealth || null,
      config,
      codexCliSnapshot,
      codexPromptInputSnapshot,
      releaseAssets,
    });
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error?.stack || error?.message || String(error),
    });
  }
})();
