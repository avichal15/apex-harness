/**
 * Apex Harness — Standalone Electron Preload Bridge (`electron/apex-preload.cjs`)
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("apexDesktopBridge", {
  standalone: true,
  runtime: "electron",
  architecture: "EGM-v5.1-NeoBrutalist",
  version: "2.0.0",
});
