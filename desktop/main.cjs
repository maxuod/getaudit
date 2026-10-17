const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
let runtime,
  win,
  db,
  stopping = false,
  restoring = false;
let releaseWriter, connectionVault;
const connectionShutdown = new AbortController();
const root = path.resolve(__dirname, "..");
const sampling = require("./sampling.cjs").createSamplingDesk();
const browserCollector = require("./chrome-collector.cjs").createChromeCollector();
// Electron uses this internal name for the macOS Safe Storage service and account.
// This clean-source build has a separate identity and never opens the installed production vault.
app.setName("getaudit Community");
// Keep community data separate from the production application.
app.setPath("userData", process.env.GEO_CONSOLE_QA ? path.resolve(process.env.GEO_CONSOLE_QA) : path.join(app.getPath("appData"), "getaudit Community"));
let uiLanguage = 'en', refreshMenu = () => {};
const nativeEnglish = require('./locales/en.cjs');
const nativeChinese = require('./locales/zh-CN.cjs');
const nt = key => (uiLanguage === 'zh-CN' ? nativeChinese[key] : undefined) ?? nativeEnglish[key];
const dataDir = app.getPath("userData"),
  ledger = path.join(dataDir, "ledger.db"),
  credentials = path.join(dataDir, "connections.enc");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !stopping) {
      win.show();
      win.focus();
    }
  });
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox(nt('getgeoCouldNotStart'), error.message);
      app.quit();
    });
}
async function moduleAt(file) {
  return import(pathToFileURL(path.join(root, "dist-node", file)).href);
}
async function boot() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { storageFields } = await moduleAt("console/settings.js");
  connectionVault = require('./connection-vault.cjs').createConnectionVault({
    file: credentials,
    fields: storageFields,
    signal: connectionShutdown.signal,
    // Electron exposes safeStorage through a getter; access it only when encryption is needed.
    getEncryption: () => {
      if (process.env.GEO_CONSOLE_QA && process.env.GEO_CONSOLE_DEMO === '1' && process.env.GEO_QA_LOCKED_CONNECTIONS === '1')
        return { isAsyncEncryptionAvailable: async () => false };
      return require('electron').safeStorage;
    },
  });
  await startService();
  refreshMenu = () => { const template = [
    {
      label: 'getaudit',
      submenu: [
        { label: nt('aboutGetgeo'), role: "about" },
        { type: "separator" },
        { label: nt('openDataFolder'), click: () => shell.openPath(dataDir) },
        { type: "separator" },
        { label: nt('quitGetgeo'), role: "quit" },
      ],
    },
    {
      label: nt('ledger'),
      submenu: [
        { label: nt('backUpCurrentLedger'), click: () => safeAction(exportBackup) },
        {
          label: nt('importRestoreLedger'),
          click: () =>
            safeAction(async () => {
              if (restoring) throw new Error(nt('aLedgerRestoreIsAlreadyInProgress'));
              restoring = true;
              try {
                await importLedger();
              } finally {
                restoring = false;
              }
            }),
        },
        { type: "separator" },
        { label: nt('reloadWorkspace'), click: () => win?.loadURL(runtime.url) },
      ],
    },
    {
      label: nt('edit'),
      submenu: [
        { label: nt('undo'), role: "undo" },
        { label: nt('redo'), role: "redo" },
        { type: "separator" },
        { label: nt('cut'), role: "cut" },
        { label: nt('copy'), role: "copy" },
        { label: nt('paste'), role: "paste" },
        { label: nt('selectAll'), role: "selectAll" },
      ],
    },
    {
      label: nt('view'),
      submenu: [
        { label: nt('actualSize'), role: "resetZoom" },
        { label: nt('zoomIn'), role: "zoomIn" },
        { label: nt('zoomOut'), role: "zoomOut" },
        { label: nt('toggleFullScreen'), role: "togglefullscreen" },
      ],
    },
    {
      label: nt('window'),
      submenu: [
        {
          label: nt('backToGetgeo'),
          accelerator: "CmdOrCtrl+Shift+L",
          click: () => {
            if (stopping) return;
            if (win) {
              win.show();
              win.focus();
            } else if (runtime) createWindow();
          },
        },
        { type: "separator" },
        { label: nt('minimize'), role: "minimize" },
        { label: nt('zoom'), role: "zoom" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template)); };
  refreshMenu();
  app.setAboutPanelOptions({ applicationName: 'getaudit', applicationVersion: app.getVersion() });
  await createWindow();
  // The complete local interface is usable while macOS collects an authorization decision.
  // A declined/failed unlock is shown in the interface; do not retry automatically.
  void loadConnections().catch(() => {});
}
async function loadConnections() {
  if (stopping || !runtime) throw new Error(nt('theAppIsClosingReopenItAfterItExits'));
  await connectionVault.load();
  if (runtime && !stopping && process.env.GEO_CONSOLE_DEMO !== '1') runtime.gscSync.start();
}
async function startService() {
  const { acquireWriterLock } = await moduleAt("db/writer-lock.js");
  releaseWriter = acquireWriterLock(ledger);
  const { connectLedger } = await moduleAt("db/index.js"),
    { LabService } = await moduleAt("console/service.js"),
    { serveConsole } = await moduleAt("console/server.js");
  if (fs.existsSync(ledger)) {
    const { DatabaseSync } = require("node:sqlite"),
      { backupLedger } = await moduleAt("console/backup.js");
    const marker = path.join(dataDir, "console-v3-brand-management-backup-complete");
    if (!fs.existsSync(marker)) {
      const ro = new DatabaseSync(ledger, { readOnly: true });
      try {
        await backupLedger(
          ro,
          path.join(dataDir, "before-console-" + Date.now() + ".db"),
        );
      } finally {
        ro.close();
      }
      fs.writeFileSync(
        marker,
        "Backup completed before first Console migration",
        { mode: 0o600 },
      );
    }
  }
  db = connectLedger(ledger);
  fs.chmodSync(ledger, 0o600);
  const lab = new LabService(db);
  if (process.env.GEO_CONSOLE_DEMO === "1") {
    const { seedDemo } = await moduleAt("console/demo.js");
    seedDemo(lab);
  }
  // Reuse the loopback port so local MCP configurations and share links survive restart.
  const portFile = path.join(dataDir,"console-port.json");
  let preferredPort = 0;
  try { const stored = JSON.parse(fs.readFileSync(portFile,"utf8"));
    if(Number.isInteger(stored.port)&&stored.port>=1024&&stored.port<=65535)preferredPort=stored.port;
  } catch {}
  const serviceOptions = {
    staticDir: path.join(root, "dist/console"),
    demo: process.env.GEO_CONSOLE_DEMO === "1",
    autoGsc: false,
    sampling,
    browserCollector,
    canMutate: () => !restoring,
    connectionAccess: () => connectionVault.state(),
    unlockConnections: loadConnections,
    openExternal: (url) => shell.openExternal(url),
    persistSettings: (values) => connectionVault.save(values),
  };
  runtime = await serveConsole(lab,{...serviceOptions,port:preferredPort,fallbackPort:true});
  if (connectionVault.state().status === 'ready' && process.env.GEO_CONSOLE_DEMO !== '1') runtime.gscSync.start();
  fs.writeFileSync(portFile,JSON.stringify({port:Number(new URL(runtime.origin).port)}),{mode:0o600});
  if (process.env.GEO_CONSOLE_QA)
    fs.writeFileSync(
      path.join(dataDir, "qa-runtime.json"),
      JSON.stringify({ url: runtime.url, ledger, versions: process.versions }),
      { mode: 0o600 },
    );
}
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: "#fff9f4",
    title: "getaudit",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.on('page-title-updated', (_event, title) => {
    const next = title === 'getaudit · 工作区' ? 'zh-CN' : 'en';
    if (next !== uiLanguage) { uiLanguage = next; refreshMenu(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== runtime.origin) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback) =>
      callback(
        permission === "clipboard-sanitized-write" &&
          contents.getURL().startsWith(runtime.origin + "/"),
      ),
  );
  win.webContents.session.setPermissionCheckHandler(
    (contents, permission) =>
      permission === "clipboard-sanitized-write" &&
      !!contents?.getURL().startsWith(runtime.origin + "/"),
  );
  win.on("closed", () => {
    win = null;
  });
  const loading = win.loadURL(runtime.url);
  if (process.env.GEO_CONSOLE_QA)
    win.webContents.once("did-finish-load", async () => {
      setTimeout(async () => {
        if (!win) return;
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(dataDir, "app-launch.png"), image.toPNG());
      }, 700);
    });
  return loading;
}
async function safeAction(action) {
  try {
    await action();
  } catch (e) {
    const message = e.message === nativeEnglish.invalidLedger ? nt('invalidLedger') : e.message;
    dialog.showErrorBox(nt('theActionCouldNotBeCompleted'), message);
  }
}
async function exportBackup() {
  const chosen = await dialog.showSaveDialog(win, {
    title: nt('backUpTheCompleteLedgerIncludesOriginalEvidence'),
    defaultPath:
      "geo-lab-backup-" + new Date().toISOString().slice(0, 10) + ".db",
    filters: [{ name: nt('sqliteLedger'), extensions: ["db"] }],
  });
  if (chosen.canceled || !chosen.filePath) return;
  const { backupLedger } = await moduleAt("console/backup.js");
  await backupLedger(db, chosen.filePath);
  await dialog.showMessageBox(win, {
    message: nt('backupSavedAndSQLiteChecksPassed'),
    detail: nt('keepThisFilePrivateItContainsOriginalEvidenceConnectionKeysAreNotIncludedInLedgerBackups'),
  });
}
async function importLedger() {
  if (browserCollector.sessions().length) throw new Error(nt('endDedicatedLoginSessionsInBatchSamplingBeforeRestoringTheLedger'));
  if (runtime.jobs.active.size || runtime.ai.active.size || runtime.browserJobs.active.size || runtime.keywordAudit.active.size)
    throw new Error(nt('pauseActiveTasksAndWaitForInFlightCallsToBeRecordedBeforeRestoringTheLedger'));
  const choice = await dialog.showOpenDialog(win, {
    title: nt('chooseAnExistingLedgerOrCompleteBackup'),
    properties: ["openFile"],
    filters: [{ name: nt('sqliteLedger'), extensions: ["db", "sqlite"] }],
  });
  if (choice.canceled || !choice.filePaths[0]) return;
  const source = choice.filePaths[0];
  if (path.resolve(source) === path.resolve(ledger))
    throw new Error(nt('thisIsAlreadyTheCurrentLedger'));
  const { DatabaseSync } = require("node:sqlite"),
    { validateLedger, backupLedger } = await moduleAt("console/backup.js");
  const ro = new DatabaseSync(source, { readOnly: true });
  const temporary = path.join(dataDir, "import-" + Date.now() + ".db");
  try {
    validateLedger(ro);
    await backupLedger(ro, temporary);
  } finally {
    ro.close();
  }
  const confirm = await dialog.showMessageBox(win, {
    type: "question",
    message: nt('useThisLedgerCopyAsYourCurrentWorkspace'),
    detail:
      nt('aCompleteBackupOfTheCurrentLedgerIsSavedFirstTheSourceFileStaysUnchangedSubsequentWorkspaceActionsUseTheWorkingCopyInTheAppDataFolder'),
    buttons: [nt('useThisLedger'), nt('cancel')],
    defaultId: 0,
    cancelId: 1,
  });
  if (confirm.response !== 0) {
    fs.unlinkSync(temporary);
    return;
  }
  await backupLedger(
    db,
    path.join(dataDir, "before-restore-" + Date.now() + ".db"),
  );
  sampling.closeAll();
  await runtime.gscSync.stop();
  await new Promise((r) => runtime.server.close(r));
  db.close();
  releaseWriter?.();
  fs.renameSync(ledger, path.join(dataDir, "previous-" + Date.now() + ".db"));
  for (const suffix of ["-wal", "-shm"])
    if (fs.existsSync(ledger + suffix)) fs.unlinkSync(ledger + suffix);
  fs.renameSync(temporary, ledger);
  await startService();
  win.loadURL(runtime.url);
}
app.on("activate", () => {
  if (!win && runtime && !stopping) void createWindow().catch(() => dialog.showErrorBox(nt('workspaceCouldNotLoad'), nt('reloadTheWorkspaceFromTheLedgerMenu')));
});
app.on("window-all-closed", () => {
  /* macOS keeps the service and jobs alive until Quit. */
});
app.on("before-quit", (event) => {
  if (stopping || !runtime) return;
  event.preventDefault();
  stopping = true;
  connectionShutdown.abort();
  sampling.closeAll();
  void Promise.all([runtime.gscSync.stop(), runtime.keywordAudit.stop(), runtime.jobs.pauseAll(), runtime.browserJobs.pauseAll(), ...runtime.ai.active.values()])
    .then(() => new Promise((r) => runtime.server.close(r)))
    .then(() => {
      db.close();
      releaseWriter?.();
      // Requests and SQLite have been drained. Exit directly so reactivation
      // cannot resurrect a window against an already closed local service.
      runtime = undefined;
      app.exit(0);
    })
    .catch((error) => {
      dialog.showErrorBox(nt('theAppCouldNotFinishClosing'), error.message);
      stopping = false;
    });
});
