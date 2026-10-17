const { BrowserWindow, shell } = require("electron");
const { randomUUID } = require("node:crypto");
function createSamplingDesk() {
  const windows = new Map();
  return {
    async open(task) {
      const existing = windows.get(task.slotId);
      if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return { opened: true };
      }
      const win = new BrowserWindow({
        title: task.name + " · 隔离采样",
        width: 1250,
        height: 940,
        webPreferences: {
          partition: "geo-sample-" + randomUUID(),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      win.geoSessionRef = randomUUID();
      windows.set(task.slotId, win);
      win.webContents.session.setPermissionRequestHandler(
        (_contents, permission, done) =>
          done(permission === "clipboard-sanitized-write"),
      );
      win.webContents.session.setPermissionCheckHandler(
        (_contents, permission) => permission === "clipboard-sanitized-write",
      );
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
        return { action: "deny" };
      });
      win.webContents.on("will-navigate", (event, url) => {
        if (!/^https:\/\//i.test(url)) event.preventDefault();
      });
      win.on("page-title-updated", (event) => {
        event.preventDefault();
        win.setTitle(task.name + " · 隔离采样");
      });
      win.on("closed", () => {
        windows.delete(task.slotId);
      });
      win.webContents.session.setUserAgent(
        win.webContents.getUserAgent(),
        task.locale,
      );
      try {
        await win.loadURL(task.url);
      } catch (error) {
        // A server-driven redirect may abort the initial navigation while
        // displaying a usable login or access-limit page. Never retry it.
        if (
          error.code !== "ERR_ABORTED" ||
          !win.webContents.getURL().startsWith("https://")
        )
          throw new Error("采样页面未能加载，请查看窗口并记录实际状态");
      }
      return { opened: true };
    },
    async capture(slotId) {
      const win = windows.get(slotId);
      if (!win || win.isDestroyed())
        throw new Error("先打开此任务的隔离采样窗口");
      // Read visible context only. Consumer pages have no Node bridge or Console token.
      const context = await win.webContents.executeJavaScript(
        "({locale:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})",
      );
      const image = await win.webContents.capturePage();
      const png = image.toPNG();
      const large = png.length > 4 * 1024 * 1024;
      const source = new URL(win.webContents.getURL());
      source.search = "";
      source.hash = "";
      return {
        artifact: {
          mime: large ? "image/jpeg" : "image/png",
          base64: (large ? image.toJPEG(85) : png).toString("base64"),
        },
        observedAt: new Date().toISOString(),
        context,
        url: source.toString(),
        sessionRef: win.geoSessionRef,
      };
    },
    closeAll() {
      for (const win of windows.values()) if (!win.isDestroyed()) win.close();
      windows.clear();
    },
  };
}
module.exports = { createSamplingDesk };
