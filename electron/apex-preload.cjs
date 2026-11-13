/**
 * Apex Harness — Authoritative Electron Preload Bridge (`electron/apex-preload.cjs`)
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("apexDesktopBridge", {
  standalone: true,
  runtime: "electron",
  architecture: "Apex-Harness-Unified-v2.5",
  version: "2.5.0",
  pickDirectory: () => ipcRenderer.invoke("apex:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("apex:open-external", url),
});
