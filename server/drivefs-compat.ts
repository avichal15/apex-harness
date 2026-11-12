// Google Drive for Desktop (DriveFS / virtual FAT32 volume on Windows) compatibility shim.
// On virtual FAT32 mounts (such as G:\My Drive), fs.symlinkSync and fs.linkSync throw EISDIR / EPERM / ENOSYS.
// These helpers try native symlink/hardlink first and transparently fall back to atomic file/directory copies.

import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export function isDriveFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "EISDIR" ||
    code === "EPERM" ||
    code === "ENOSYS" ||
    code === "ENOTSUP" ||
    code === "EXDEV" ||
    code === "EINVAL"
  );
}

/**
 * Creates a symlink or Windows junction when supported by the underlying filesystem;
 * falls back to a recursive copy on Google Drive (FAT32 DriveFS) volumes.
 */
export function safeSymlinkOrCopySync(
  target: string,
  linkPath: string,
  type?: "dir" | "file" | "junction",
): "symlink" | "copied" {
  const resolvedTarget = resolve(target);
  const resolvedLink = resolve(linkPath);
  mkdirSync(dirname(resolvedLink), { recursive: true, mode: 0o700 });

  try {
    const effectiveType =
      process.platform === "win32"
        ? type ?? (statSync(resolvedTarget).isDirectory() ? "junction" : "file")
        : type;
    symlinkSync(resolvedTarget, resolvedLink, effectiveType);
    return "symlink";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return "symlink";
    }
    if (!isDriveFsError(error)) {
      throw error;
    }
    if (!existsSync(resolvedTarget)) {
      throw error;
    }
    const targetStat = statSync(resolvedTarget);
    try {
      if (existsSync(resolvedLink) || lstatSync(resolvedLink)) {
        rmSync(resolvedLink, { recursive: true, force: true });
      }
    } catch {
      // Ignore if link does not exist yet
    }
    if (targetStat.isDirectory()) {
      cpSync(resolvedTarget, resolvedLink, { recursive: true, force: true });
    } else {
      copyFileSync(resolvedTarget, resolvedLink);
    }
    return "copied";
  }
}

/**
 * Creates a hard link when supported; falls back to copyFileSync on Google Drive (FAT32 DriveFS).
 */
export function safeLinkOrCopySync(existingPath: string, newPath: string): "linked" | "copied" {
  mkdirSync(dirname(resolve(newPath)), { recursive: true, mode: 0o700 });
  try {
    linkSync(existingPath, newPath);
    return "linked";
  } catch (error) {
    if (!isDriveFsError(error)) {
      throw error;
    }
    if (existsSync(newPath)) {
      const err = new Error(`EEXIST: file already exists, link '${existingPath}' -> '${newPath}'`) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    }
    copyFileSync(existingPath, newPath);
    return "copied";
  }
}
