/**
 * Apex Harness — Standalone Electron Desktop Main Entry (`electron/apex-main.mjs`)
 *
 * Supervises the embedded Apex App Server (`server/apex-app-server.ts`) inside
 * the Electron Main Process so Apex Harness runs as a 100% standalone desktop
 * application (like Claude Desktop, Codex, or Antigravity) with zero external
 * terminal or parent IDE dependency.
 */

import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SERVER_ENTRY = join(PROJECT_ROOT, "server", "apex-app-server.ts");
const PORT = Number(process.env.APEX_PORT || 5199);
const SERVER_URL = `http://127.0.0.1:${PORT}`;

let backendChild = null;
let mainWindow = null;
let isQuitting = false;

function checkBackendAlive() {
  return new Promise((resolvePromise) => {
    const req = http.get(`${SERVER_URL}/api/bootstrap`, { timeout: 1200 }, (res) => {
      res.resume();
      resolvePromise(res.statusCode === 200);
    });
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
      APEX_PROJECT_ROOT: PROJECT_ROOT,
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

async function createApexWindow() {
  await ensureEmbeddedBackend();

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    title: "Apex",
    backgroundColor: "#0D0E10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "apex-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await mainWindow.loadURL(SERVER_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createApexWindow);

app.on("before-quit", () => {
  isQuitting = true;
  if (backendChild && !backendChild.killed) {
    try {
      backendChild.kill("SIGTERM");
    } catch {
      // Ignore cleanup race
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
