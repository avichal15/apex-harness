/**
 * Apex Harness — Desktop Packaging & Path-With-Spaces Smoke Verifier (`scripts/smoke-apex-desktop.mjs`)
 *
 * Verifies:
 * 1. `electron-builder.apex.yml` configures `electron/apex-main.mjs`, `com.avichal.apexharness`,
 *    `ApexHarness`, and preserves OpenMausBot `LICENSE` / `NOTICE` files.
 * 2. Staging the packaged `resources/app` layout inside a directory path containing spaces
 *    (`Apex Harness Desktop Smoke <ts>`) and launching `electron/apex-main.mjs --smoke-test`
 *    starts the embedded Apex server, passes `/api/health` (`200 OK`), and exits cleanly (`0`).
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const builderConfigPath = join(repoRoot, "electron-builder.apex.yml");
assert.ok(existsSync(builderConfigPath), "electron-builder.apex.yml must exist");
const builderYaml = readFileSync(builderConfigPath, "utf8");
assert.match(builderYaml, /appId:\s*com\.avichal\.apexharness/);
assert.match(builderYaml, /productName:\s*ApexHarness/);
assert.match(builderYaml, /main:\s*electron\/apex-main\.mjs/);
assert.match(builderYaml, /OpenMausBot-LICENSE\.txt/);

const pkgJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
assert.equal(
  pkgJson.main,
  "electron/apex-main.mjs",
  "package.json main entry must match electron-builder.apex.yml (electron/apex-main.mjs)",
);

const spacedRoot = join(tmpdir(), `Apex Harness Desktop Smoke ${Date.now()}`);
const appDir = join(spacedRoot, "resources", "app");
mkdirSync(appDir, { recursive: true });

try {
  for (const rel of [
    "electron/apex-main.mjs",
    "electron/apex-preload.cjs",
    "server",
    "shared",
    "ui",
    "skills",
    "harness2",
    "package.json",
    "LICENSE",
    "NOTICE",
  ]) {
    const src = join(repoRoot, rel);
    const dest = join(appDir, rel);
    if (existsSync(src)) {
      cpSync(src, dest, {
        recursive: true,
        filter: (s) => !s.endsWith(".node-test.mjs") && !s.endsWith(".test.ts"),
      });
    }
  }

  const smokeEntry = join(appDir, "electron", "apex-main.mjs");
  const res = spawnSync(process.execPath, ["--experimental-strip-types", smokeEntry, "--smoke-test"], {
    cwd: appDir,
    encoding: "utf8",
    timeout: 25_000,
    windowsHide: true,
  });

  if (res.status !== 0) {
    console.error("Smoke stdout:", res.stdout);
    console.error("Smoke stderr:", res.stderr);
  }
  assert.equal(res.status, 0, `Desktop smoke test failed with exit code ${res.status}`);

  const lines = (res.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const payload = JSON.parse(lines[lines.length - 1] || "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.mode, "apex-desktop-smoke-test");
  assert.ok(payload.modelsCount > 0, "Smoke test must load unified model fleet");
  assert.ok(payload.skillsCount > 0, "Smoke test must load bundled canonical skills");
  assert.ok(
    payload.projectRoot.includes("Apex Harness Desktop Smoke"),
    `Expected projectRoot to contain spaces, got: ${payload.projectRoot}`,
  );

  console.log("[Apex Desktop Smoke] PASS:", JSON.stringify(payload));
} finally {
  rmSync(spacedRoot, { recursive: true, force: true });
}
