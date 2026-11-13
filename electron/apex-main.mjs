/**
 * Apex Harness — Authoritative Electron Desktop Main Entry (`electron/apex-main.mjs`)
 *
 * Supervises the embedded Apex App Server (`server/apex-app-server.ts`) inside
 * the Electron Main Process with:
 * - Per-session cryptographic authentication token (`APEX_SESSION_TOKEN`)
 * - Native folder-picker and external link IPC handlers
 * - Full process-tree termination on application exit (`taskkill /T /F` on Windows)
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = join(PROJECT_ROOT, "server", "apex-app-server.ts");
const PORT = Number(process.env.APEX_PORT || process.env.APEX_APP_PORT || 5199);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
const SESSION_TOKEN = process.env.APEX_SESSION_TOKEN || randomBytes(24).toString("hex");

let backendChild = null;
let mainWindow = null;
let isQuitting = false;

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

function checkBackendAlive() {
  return new Promise((resolvePromise) => {
    const req = http.get(
      `${SERVER_URL}/api/bootstrap`,
      {
        timeout: 1200,
        headers: { "X-Apex-Token": SESSION_TOKEN },
      },
      (res) => {
        res.resume();
        resolvePromise(res.statusCode === 200);
      },
    );
    req.on("error", () => resolvePromise(false));
    req.on("timeout", () => {
      req.destroy();
      resolvePromise(false);
    });
  });
}

async function ensureEmbeddedBackend() {
  const alreadyUp = await checkBackendAlive();
  if (alreadyUp) return;

  const nodeBin = process.env.APEX_NODE_BIN || "node";
  backendChild = spawn(nodeBin, ["--experimental-strip-types", SERVER_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      APEX_PORT: String(PORT),
      APEX_APP_PORT: String(PORT),
      APEX_PROJECT_ROOT: PROJECT_ROOT,
      APEX_SESSION_TOKEN: SESSION_TOKEN,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  backendChild.on("exit", (code) => {
    backendChild = null;
    if (!isQuitting && code !== 0) {
      setTimeout(() => {
        ensureEmbeddedBackend().catch(() => {});
      }, 1500);
    }
  });

  for (let attempt = 0; attempt < 40; attempt++) {
    if (await checkBackendAlive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
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
  await ensureEmbeddedBackend();

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
