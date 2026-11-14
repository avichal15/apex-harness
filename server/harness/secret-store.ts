// OS-Backed & CSPRNG Master Secret Store for Apex Harness.
// Replaces predictable hostname/username key derivation with:
// 1. Explicit operator environment passphrase (`APEX_VAULT_KEY` via scrypt)
// 2. Windows DPAPI (`System.Security.Cryptography.ProtectedData` CurrentUser scope enabled by default on win32 unless `APEX_DISABLE_DPAPI=1`)
// 3. Per-installation 256-bit CSPRNG master key (`crypto.randomBytes(32)`) persisted in `<dataDir>/.master-key` with 0o600 permissions.
// 4. Corruption & missing-key protection that refuses to silently regenerate `.master-key` when encrypted vault entries already exist.

import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  fallbackReason?: string;
}

export class MasterVaultKeyCorruptedError extends Error {
  readonly code = "MASTER_VAULT_KEY_CORRUPTED";
  readonly reason: "corrupted_master_key" | "missing_master_key_with_existing_vault";
  readonly masterKeyPath: string;
  readonly corruptBackupPath?: string;
  readonly existingVaultEntriesCount: number;

  constructor(input: {
    message: string;
    reason: "corrupted_master_key" | "missing_master_key_with_existing_vault";
    masterKeyPath: string;
    corruptBackupPath?: string;
    existingVaultEntriesCount: number;
  }) {
    super(input.message);
    this.name = "MasterVaultKeyCorruptedError";
    this.reason = input.reason;
    this.masterKeyPath = input.masterKeyPath;
    this.corruptBackupPath = input.corruptBackupPath;
    this.existingVaultEntriesCount = input.existingVaultEntriesCount;
  }
}

const masterKeyCache = new Map<string, MasterVaultKeyInfo>();

export function clearMasterKeyCache(dataDir?: string): void {
  if (dataDir) {
    masterKeyCache.delete(resolve(dataDir));
  } else {
    masterKeyCache.clear();
  }
}

export function getMasterKeyFilePath(dataDir: string): string {
  return join(resolve(dataDir), ".master-key");
}

function getVaultFilePath(dataDir: string): string {
  return join(resolve(dataDir), "apex-provider-secrets.enc.json");
}

function inspectExistingVaultState(dataDir: string): {
  totalEntries: number;
  v2Entries: number;
} {
  const vaultPath = getVaultFilePath(dataDir);
  if (!existsSync(vaultPath)) {
    return { totalEntries: 0, v2Entries: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(vaultPath, "utf8")) as Record<
      string,
      EncryptedVaultRecord
    >;
    const entries = Object.values(parsed ?? {}).filter(
      (v) => v && typeof v === "object" && typeof v.ciphertext === "string",
    );
    const v2Entries = entries.filter((v) => Boolean(v.keySource)).length;
    return { totalEntries: entries.length, v2Entries };
  } catch {
    return { totalEntries: 0, v2Entries: 0 };
  }
}

function tryDpapiProtect(rawKey: Buffer): { blob: string | null; errorReason?: string } {
  if (process.platform !== "win32") {
    return { blob: null, errorReason: `platform_not_win32 (${process.platform})` };
  }
  if (process.env.APEX_DISABLE_DPAPI === "1") {
    return { blob: null, errorReason: "disabled_via_APEX_DISABLE_DPAPI" };
  }
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
      return { blob: res.stdout.trim() };
    }
    return {
      blob: null,
      errorReason: `powershell_dpapi_exit_${res.status ?? "null"}`,
    };
  } catch (err) {
    return {
      blob: null,
      errorReason: `powershell_dpapi_exception: ${(err as Error).message}`,
    };
  }
}

function tryDpapiUnprotect(dpapiBase64: string): Buffer | null {
  if (process.platform !== "win32") return null;
  try {
    const clean = dpapiBase64.replace(/[^A-Za-z0-9+/=]/g, "");
    if (!clean || clean.length < 16) return null;
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

function writeMasterKeyFile(
  masterKeyPath: string,
  rawKey: Buffer,
): { source: VaultKeySource; fallbackReason?: string } {
  let source: VaultKeySource = "csprng_master_key_file";
  let fallbackReason: string | undefined;
  let serialized = `CSPRNG_HEX:${rawKey.toString("hex")}\n`;

  if (process.platform === "win32" && process.env.APEX_DISABLE_DPAPI !== "1") {
    const dpapiRes = tryDpapiProtect(rawKey);
    if (dpapiRes.blob) {
      source = "windows_dpapi";
      serialized = `DPAPI:${dpapiRes.blob}\n`;
    } else {
      fallbackReason = dpapiRes.errorReason || "dpapi_unavailable";
    }
  } else if (process.platform !== "win32") {
    fallbackReason = `non_windows_platform (${process.platform})`;
  } else {
    fallbackReason = "disabled_via_APEX_DISABLE_DPAPI";
  }

  mkdirSync(dirname(masterKeyPath), { recursive: true, mode: 0o700 });
  writeFileSync(masterKeyPath, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(masterKeyPath, 0o600);
  } catch {
    // Windows ACLs handled by user profile directory
  }
  return { source, fallbackReason };
}

/**
 * Loads or generates a 32-byte (256-bit) master encryption key for `<dataDir>`.
 * Never derives active encryption keys from predictable hostname/username strings,
 * and never silently regenerates `.master-key` when `.master-key` is corrupted or
 * missing while encrypted v2 secrets already exist.
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
  const vaultState = inspectExistingVaultState(canonicalDir);

  if (existsSync(masterKeyPath)) {
    const rawContent = readFileSync(masterKeyPath, "utf8").trim();
    if (rawContent.startsWith("DPAPI:")) {
      const payload = rawContent.slice("DPAPI:".length).trim();
      const unprotected = tryDpapiUnprotect(payload);
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
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        const buf = Buffer.from(hex, "hex");
        if (buf.length === 32) {
          const info: MasterVaultKeyInfo = {
            key: buf,
            source: "csprng_master_key_file",
            masterKeyPath,
            fallbackReason:
              process.platform === "win32"
                ? "existing_csprng_master_key_file"
                : `non_windows_platform (${process.platform})`,
          };
          masterKeyCache.set(canonicalDir, info);
          return info;
        }
      }
    }

    // Existing .master-key failed to parse or unprotect! Never silently overwrite it.
    const corruptBackupPath = `${masterKeyPath}.corrupt`;
    try {
      copyFileSync(masterKeyPath, corruptBackupPath);
    } catch {
      // Best-effort backup of corrupted key file
    }
    masterKeyCache.delete(canonicalDir);
    throw new MasterVaultKeyCorruptedError({
      message: `Master vault key at '${masterKeyPath}' is corrupted or could not be unprotected via DPAPI (${vaultState.totalEntries} encrypted secret(s) in vault). Backed up corrupted key to '${corruptBackupPath}'. Restore from backup or call recoverOrResetCorruptedMasterKey().`,
      reason: "corrupted_master_key",
      masterKeyPath,
      corruptBackupPath,
      existingVaultEntriesCount: vaultState.totalEntries,
    });
  }

  // .master-key does not exist on disk: check if v2 encrypted secrets already exist
  if (vaultState.v2Entries > 0) {
    masterKeyCache.delete(canonicalDir);
    throw new MasterVaultKeyCorruptedError({
      message: `Master vault key at '${masterKeyPath}' is missing while ${vaultState.v2Entries} encrypted v2 secret(s) exist in '${getVaultFilePath(canonicalDir)}'. Refusing to silently regenerate master key and orphan existing credentials.`,
      reason: "missing_master_key_with_existing_vault",
      masterKeyPath,
      existingVaultEntriesCount: vaultState.totalEntries,
    });
  }

  const csprngKey = randomBytes(32);
  const written = writeMasterKeyFile(masterKeyPath, csprngKey);

  const info: MasterVaultKeyInfo = {
    key: csprngKey,
    source: written.source,
    masterKeyPath,
    fallbackReason: written.fallbackReason,
  };
  masterKeyCache.set(canonicalDir, info);
  return info;
}

/**
 * Exports a hex backup of the current 256-bit master key so operators can
 * recover their encrypted vault if `.master-key` is ever damaged or lost.
 */
export function exportMasterKeyBackupHex(dataDir: string): string {
  const { key } = getOrCreateMasterVaultKey(dataDir);
  return key.toString("hex");
}

/**
 * Explicitly recovers a corrupted/missing `.master-key` from a 64-char hex backup key,
 * or resets the vault when `confirmOrphanExistingSecrets: true` is explicitly passed.
 */
export function recoverOrResetCorruptedMasterKey(
  dataDir: string,
  options: {
    backupKeyHex?: string;
    confirmOrphanExistingSecrets?: boolean;
  },
): MasterVaultKeyInfo {
  const canonicalDir = resolve(dataDir);
  const masterKeyPath = getMasterKeyFilePath(canonicalDir);
  clearMasterKeyCache(canonicalDir);

  if (options.backupKeyHex) {
    const cleanHex = options.backupKeyHex.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(cleanHex)) {
      throw new Error("Invalid backupKeyHex: must be a 64-character hexadecimal string (32 bytes).");
    }
    const restoredKey = Buffer.from(cleanHex, "hex");
    const written = writeMasterKeyFile(masterKeyPath, restoredKey);
    const info: MasterVaultKeyInfo = {
      key: restoredKey,
      source: written.source,
      masterKeyPath,
      fallbackReason: written.fallbackReason,
    };
    masterKeyCache.set(canonicalDir, info);
    return info;
  }

  if (options.confirmOrphanExistingSecrets) {
    const vaultPath = getVaultFilePath(canonicalDir);
    if (existsSync(vaultPath)) {
      try {
        copyFileSync(vaultPath, `${vaultPath}.orphaned`);
      } catch {
        // Ignore
      }
      writeFileSync(vaultPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    }
    const freshKey = randomBytes(32);
    const written = writeMasterKeyFile(masterKeyPath, freshKey);
    const info: MasterVaultKeyInfo = {
      key: freshKey,
      source: written.source,
      masterKeyPath,
      fallbackReason: written.fallbackReason,
    };
    masterKeyCache.set(canonicalDir, info);
    return info;
  }

  throw new Error(
    "recoverOrResetCorruptedMasterKey requires either 'backupKeyHex' or 'confirmOrphanExistingSecrets: true'.",
  );
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

export function encryptLegacyV1SecretForMigrationTest(
  dataDir: string,
  plaintext: string,
): EncryptedVaultRecord {
  const legacyKey = deriveLegacyV1KeyForMigrationOnly(dataDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: encrypted.toString("hex"),
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
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
