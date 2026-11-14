/**
 * Apex Harness — Authoritative Electron Desktop Main Entry (`electron/apex-main.mjs`)
 *
 * Supervises the embedded Apex App Server (`server/apex-app-server.ts`) inside
 * the Electron Main Process with:
 * - Per-session cryptographic authentication token (`APEX_SESSION_TOKEN`)
 * - Native folder-picker and external link IPC handlers
 * - Full process-tree termination on application exit (`taskkill /T /F` on Windows)
 * - Reproducible `--smoke-test` verification mode (works in Electron and headless CI,
 *   including paths containing spaces)
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = join(PROJECT_ROOT, "server", "apex-app-server.ts");
const IS_SMOKE_TEST =
  process.argv.includes("--smoke-test") || process.env.APEX_DESKTOP_SMOKE_TEST === "1";
const SESSION_TOKEN = process.env.APEX_SESSION_TOKEN || randomBytes(24).toString("hex");

let PORT = Number(process.env.APEX_PORT || process.env.APEX_APP_PORT || 5199);
let SERVER_URL = `http://127.0.0.1:${PORT}`;

let backendChild = null;
let mainWindow = null;
let isQuitting = false;

function findFreeLocalPort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 5299;
      srv.close(() => resolvePort(port));
    });
    srv.on("error", rejectPort);
  });
}

function killChildProcessTree(pid) {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 4000,
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    // Process already exited
  }
}

function fetchBackendHealth(pathname = "/api/health") {
  return new Promise((resolvePromise) => {
    const req = http.get(
      `${SERVER_URL}${pathname}`,
      {
        timeout: 1500,
        headers: {
          "X-Apex-Token": SESSION_TOKEN,
          Origin: SERVER_URL,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // Ignore
          }
          resolvePromise({
            ok: res.statusCode === 200,
            statusCode: res.statusCode,
            body: parsed,
          });
        });
      },
    );
    req.on("error", () => resolvePromise({ ok: false, statusCode: 0, body: null }));
    req.on("timeout", () => {
      req.destroy();
      resolvePromise({ ok: false, statusCode: 0, body: null });
    });
  });
}

async function checkBackendAlive() {
  const res = await fetchBackendHealth("/api/health");
  return res.ok;
}

function resolveBackendNodeRuntime(isPackagedElectron) {
  if (process.env.APEX_NODE_BIN) {
    return { bin: process.env.APEX_NODE_BIN, extraEnv: {} };
  }
  if (isPackagedElectron && process.versions.electron) {
    return { bin: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { bin: "node", extraEnv: {} };
}

async function ensureEmbeddedBackend(isPackagedElectron = false) {
  if (!IS_SMOKE_TEST) {
    const alreadyUp = await checkBackendAlive();
    if (alreadyUp) return;
  }

  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`Embedded Apex server entry not found at: ${SERVER_ENTRY}`);
  }

  const runtime = resolveBackendNodeRuntime(isPackagedElectron);
  backendChild = spawn(runtime.bin, ["--experimental-strip-types", SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ...runtime.extraEnv,
      APEX_PORT: String(PORT),
      APEX_APP_PORT: String(PORT),
      APEX_PROJECT_ROOT: PROJECT_ROOT,
      APEX_SESSION_TOKEN: SESSION_TOKEN,
    },
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  backendChild.on("exit", (code) => {
    backendChild = null;
    if (!isQuitting && !IS_SMOKE_TEST && code !== 0) {
      setTimeout(() => {
        ensureEmbeddedBackend(isPackagedElectron).catch(() => {});
      }, 1500);
    }
  });

  for (let attempt = 0; attempt < 50; attempt++) {
    if (await checkBackendAlive()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for embedded Apex server at ${SERVER_URL} (${SERVER_ENTRY})`);
}

async function runDesktopSmokeTest(electronApp = null) {
  try {
    if (!process.env.APEX_SMOKE_PORT) {
      PORT = await findFreeLocalPort();
      SERVER_URL = `http://127.0.0.1:${PORT}`;
    }
    await ensureEmbeddedBackend(Boolean(electronApp?.isPackaged));
    const health = await fetchBackendHealth("/api/health");
    if (!health.ok || health.body?.status !== "ok") {
      throw new Error(`Health check failed: ${JSON.stringify(health)}`);
    }
    console.log(
      JSON.stringify({
        ok: true,
        mode: "apex-desktop-smoke-test",
        serverUrl: SERVER_URL,
        projectRoot: PROJECT_ROOT,
        reportedProjectRoot: health.body?.projectRoot,
        modelsCount: Array.isArray(health.body?.models) ? health.body.models.length : 0,
        skillsCount: Array.isArray(health.body?.skills) ? health.body.skills.length : 0,
      }),
    );
    isQuitting = true;
    if (backendChild && backendChild.pid) {
      killChildProcessTree(backendChild.pid);
      backendChild = null;
    }
    if (electronApp) {
      electronApp.exit(0);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error("[Apex Desktop Smoke Error]", err);
    isQuitting = true;
    if (backendChild && backendChild.pid) {
      killChildProcessTree(backendChild.pid);
      backendChild = null;
    }
    if (electronApp) {
      electronApp.exit(1);
    } else {
      process.exit(1);
    }
  }
}

async function startDesktopRuntime() {
  if (process.argv.includes("--openmausbot") || process.env.OMB_DESKTOP === "1") {
    await import("./main.mjs");
    return;
  }

  if (IS_SMOKE_TEST && !process.versions.electron) {
    await runDesktopSmokeTest(null);
    return;
  }

  const electronMod = await import("electron");
  const { app, BrowserWindow, dialog, ipcMain, shell } = electronMod;

  app.setName("ApexHarness");
  if (process.platform === "win32" && typeof app.setAppUserModelId === "function") {
    app.setAppUserModelId("com.avichal.apexharness");
  }

  if (IS_SMOKE_TEST) {
    app.whenReady().then(() => runDesktopSmokeTest(app));
    return;
  }

  function registerDesktopIpc() {
    ipcMain.handle("apex:pick-folder", async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "Select Workspace Folder",
        properties: ["openDirectory"],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return null;
      }
      return result.filePaths[0];
    });

    ipcMain.handle("apex:open-external", async (_event, targetUrl) => {
      if (typeof targetUrl === "string" && /^https?:\/\//i.test(targetUrl)) {
        await shell.openExternal(targetUrl);
        return true;
      }
      return false;
    });
  }

  async function createApexWindow() {
    registerDesktopIpc();
    await ensureEmbeddedBackend(Boolean(app.isPackaged));

    mainWindow = new BrowserWindow({
      width: 1480,
      height: 920,
      minWidth: 1024,
      minHeight: 680,
      title: "Apex Harness Studio",
      backgroundColor: "#0D0E10",
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, "apex-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    await mainWindow.loadURL(SERVER_URL);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }

  app.whenReady().then(createApexWindow);

  app.on("before-quit", () => {
    isQuitting = true;
    if (backendChild && backendChild.pid) {
      killChildProcessTree(backendChild.pid);
      backendChild = null;
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

startDesktopRuntime();
