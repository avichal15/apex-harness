// OS-Backed & CSPRNG Master Secret Store for Apex Harness.
// Replaces predictable hostname/username key derivation with:
// 1. Explicit operator environment passphrase (`APEX_VAULT_KEY` via scrypt)
// 2. Windows DPAPI (`System.Security.Cryptography.ProtectedData` CurrentUser scope when `APEX_USE_DPAPI=1`)
// 3. Per-installation 256-bit CSPRNG master key (`crypto.randomBytes(32)`) persisted in `<dataDir>/.master-key` with 0o600 permissions.

import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

export type VaultKeySource =
  | "env_override"
  | "windows_dpapi"
  | "csprng_master_key_file";

export interface MasterVaultKeyInfo {
  key: Buffer;
  source: VaultKeySource;
  masterKeyPath: string;
}

const masterKeyCache = new Map<string, MasterVaultKeyInfo>();

export function getMasterKeyFilePath(dataDir: string): string {
  return join(resolve(dataDir), ".master-key");
}

function tryDpapiProtect(rawKey: Buffer): string | null {
  if (process.platform !== "win32") return null;
  try {
    const b64In = rawKey.toString("base64");
    const psScript = [
      "Add-Type -AssemblyName System.Security;",
      `$bytes = [Convert]::FromBase64String('${b64In}');`,
      "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
      "[Convert]::ToBase64String($enc)",
    ].join(" ");
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { encoding: "utf8", timeout: 4_000, windowsHide: true },
    );
    if (res.status === 0 && res.stdout.trim()) {
      return res.stdout.trim();
    }
  } catch {
    // Fallback to CSPRNG file if PowerShell DPAPI call is unavailable
  }
  return null;
}

function tryDpapiUnprotect(dpapiBase64: string): Buffer | null {
  if (process.platform !== "win32") return null;
  try {
    const clean = dpapiBase64.replace(/[^A-Za-z0-9+/=]/g, "");
    const psScript = [
      "Add-Type -AssemblyName System.Security;",
      `$enc = [Convert]::FromBase64String('${clean}');`,
      "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
      "[Convert]::ToBase64String($dec)",
    ].join(" ");
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { encoding: "utf8", timeout: 4_000, windowsHide: true },
    );
    if (res.status === 0 && res.stdout.trim()) {
      const buf = Buffer.from(res.stdout.trim(), "base64");
      if (buf.length === 32) return buf;
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Loads or generates a 32-byte (256-bit) master encryption key for `<dataDir>`.
 * Never derives active encryption keys from predictable hostname/username strings.
 */
export function getOrCreateMasterVaultKey(dataDir: string): MasterVaultKeyInfo {
  const canonicalDir = resolve(dataDir);
  const masterKeyPath = getMasterKeyFilePath(canonicalDir);

  if (process.env.APEX_VAULT_KEY && process.env.APEX_VAULT_KEY.trim()) {
    const derived = scryptSync(
      process.env.APEX_VAULT_KEY.trim(),
      "apex-vault-v2-scrypt-salt",
      32,
    );
    return {
      key: derived,
      source: "env_override",
      masterKeyPath,
    };
  }

  const cached = masterKeyCache.get(canonicalDir);
  if (cached && existsSync(masterKeyPath)) {
    return cached;
  }

  mkdirSync(dirname(masterKeyPath), { recursive: true, mode: 0o700 });

  if (existsSync(masterKeyPath)) {
    try {
      const rawContent = readFileSync(masterKeyPath, "utf8").trim();
      if (rawContent.startsWith("DPAPI:")) {
        const unprotected = tryDpapiUnprotect(rawContent.slice("DPAPI:".length));
        if (unprotected && unprotected.length === 32) {
          const info: MasterVaultKeyInfo = {
            key: unprotected,
            source: "windows_dpapi",
            masterKeyPath,
          };
          masterKeyCache.set(canonicalDir, info);
          return info;
        }
      } else if (rawContent.startsWith("CSPRNG_HEX:")) {
        const hex = rawContent.slice("CSPRNG_HEX:".length).trim();
        const buf = Buffer.from(hex, "hex");
        if (buf.length === 32) {
          const info: MasterVaultKeyInfo = {
            key: buf,
            source: "csprng_master_key_file",
            masterKeyPath,
          };
          masterKeyCache.set(canonicalDir, info);
          return info;
        }
      }
    } catch {
      // Regenerate below if corrupted
    }
  }

  const csprngKey = randomBytes(32);
  let source: VaultKeySource = "csprng_master_key_file";
  let serialized = `CSPRNG_HEX:${csprngKey.toString("hex")}\n`;

  if (process.platform === "win32" && process.env.APEX_USE_DPAPI === "1") {
    const dpapiBlob = tryDpapiProtect(csprngKey);
    if (dpapiBlob) {
      source = "windows_dpapi";
      serialized = `DPAPI:${dpapiBlob}\n`;
    }
  }

  writeFileSync(masterKeyPath, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(masterKeyPath, 0o600);
  } catch {
    // Windows ACLs handled by user profile directory
  }

  const info: MasterVaultKeyInfo = {
    key: csprngKey,
    source,
    masterKeyPath,
  };
  masterKeyCache.set(canonicalDir, info);
  return info;
}

/**
 * Legacy v1 key derivation used strictly as a read-only fallback to migrate
 * pre-existing vault entries transparently without losing user API keys.
 */
function deriveLegacyV1KeyForMigrationOnly(dataDir: string): Buffer {
  const user = (() => {
    try {
      return userInfo().username;
    } catch {
      return "apex-operator";
    }
  })();
  const seed = `apex-vault-v1:${hostname()}:${user}:${resolve(dataDir)}`;
  return createHash("sha256").update(seed).digest();
}

export interface EncryptedVaultRecord {
  iv: string;
  tag: string;
  ciphertext: string;
  keySource?: VaultKeySource;
  updatedAt: string;
}

export function encryptSecretWithMasterKey(
  dataDir: string,
  plaintext: string,
): EncryptedVaultRecord {
  const { key, source } = getOrCreateMasterVaultKey(dataDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: encrypted.toString("hex"),
    keySource: source,
    updatedAt: new Date().toISOString(),
  };
}

export function decryptSecretWithMasterKey(
  dataDir: string,
  record: EncryptedVaultRecord,
): { plaintext: string; migratedFromLegacy: boolean } | null {
  const { key } = getOrCreateMasterVaultKey(dataDir);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(record.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(record.tag, "hex"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "hex")),
      decipher.final(),
    ]);
    return {
      plaintext: decrypted.toString("utf8"),
      migratedFromLegacy: false,
    };
  } catch {
    // Attempt read-only migration from legacy v1 vault record
    try {
      const legacyKey = deriveLegacyV1KeyForMigrationOnly(dataDir);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        legacyKey,
        Buffer.from(record.iv, "hex"),
      );
      decipher.setAuthTag(Buffer.from(record.tag, "hex"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "hex")),
        decipher.final(),
      ]);
      return {
        plaintext: decrypted.toString("utf8"),
        migratedFromLegacy: true,
      };
    } catch {
      return null;
    }
  }
}
