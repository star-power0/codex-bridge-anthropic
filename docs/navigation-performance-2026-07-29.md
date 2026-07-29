# Navigation Performance Remediation

## Scope

This change addresses visible pauses while switching between the Models,
Capabilities, Statistics, Settings, Resources, and Sessions pages.

## Root Causes

1. Navigation rebuilt the active page with `innerHTML` on every switch, even
   when the state had not changed.
2. A full state request loaded unrelated details together: capabilities also
   read Codex sessions, resources, preflight data, and thumbnail-bearing
   histories.
3. Usage and log broadcasts updated DOM while unrelated pages were active.
4. Saving provider settings broadcast a full state and then built a second
   full state for the IPC response before returning to the model list.
5. When a page cache was invalid, navigation changed the selected classes and
   then rebuilt the Models or Capabilities DOM in the same click task. Chromium
   could not paint the selected navigation item until that synchronous work
   completed.
6. The first Preflight visit built the complete startup check in Electron's
   main process. Session, plugin, resource, backup, and installation scans
   blocked window input dispatch until the check completed.

## Changes

- Cache rendered navigation pages by state revision. Re-entering a page with
  unchanged state reuses its existing DOM and event bindings.
- Invalidate only the Statistics and Overview pages for usage updates, and
  only the Logs page for log updates.
- Load detail state by page:
  - Preflight loads only the startup check.
  - Capabilities loads only capability/image histories and related settings.
  - Resources loads only Codex resource snapshots.
  - Sessions loads only the Codex session tree and recovery plan.
- Retain previously loaded detail slices when a later page-specific request
  returns a lightweight state payload.
- Bound the first capability-page history payload to 48 capability records and
  36 image records, including thumbnails only within those limits.
- Save provider settings without publishing or returning a full state. The
  model catalog fetches one lightweight state only when the user returns to it.
- Keep the image-input toggle durable, but update its active model card
  locally rather than broadcasting and rerendering the entire application.
- Paint the selected navigation item and newly visible panel before rebuilding
  invalid page content. Deferred work checks the active page again so rapid
  navigation cannot render a stale destination.
- Run both first-load and manual startup checks in a worker thread. The check
  remains complete, but Electron's main process stays available to dispatch
  navigation input while it runs.

## Verification

The following checks passed:

```powershell
node --check desktop/main.cjs
node --check desktop/renderer/app.js
node --check desktop/settings.mjs
node scripts/verify-claude-messages-native.mjs
node scripts/verify-navigation-paint.mjs
node scripts/verify-preflight-worker.mjs
git diff --check
```

The extracted application directory does not include `node_modules/electron`,
`scripts/desktop-smoke.mjs`, or `scripts/route-sync-smoke.mjs`, although the
package scripts reference the latter two paths. Therefore `npm run
desktop:smoke` and the package route-smoke command cannot execute from this
directory. The installed Windows application remains the runtime verification
target.

---

## Addendum — 刷新模型卡顿（2026-07-29 续）

### Root Causes

7. `providers:refreshModels` IPC 刷新完后调用 `getStatePayload(settings)`（无参数），`includeAllDetail = true`，触发 `readCodexResourceSnapshotsRetained` 发起 Codex 插件市场网络请求，与模型刷新完全无关，却阻塞了整个 IPC 响应返回。
8. 刷新模型按钮回调在 IPC 返回后调用 `render()`，内部走 `renderActiveSection("models", { force: true })`，全量重建 models 页所有子渲染函数（renderModelPool/renderProviderEditor/renderCustomEditor/renderSelectedModels/renderProviderPreview/renderCustomFormState）并重绑所有事件，开销远超实际需要。

### Changes

- `desktop/main.cjs`：`providers:refreshModels` handler 的返回值从 `getStatePayload(settings)` 改为 `getStatePayload(settings, { lite: true })`，跳过资源快照网络调用。
- `desktop/renderer/app.js`：刷新模型按钮回调从 `render()` 改为精准调用 `renderModelPool() + renderProviderEditor() + renderSelectedModels()`，只重建模型页相关 DOM 节点。

### Verification

```powershell
node --check desktop/main.cjs
node --check desktop/renderer/app.js
git diff --check
```