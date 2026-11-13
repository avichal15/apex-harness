// P0 Workspace Canonical Containment & Local API Security Boundary for Apex Harness.
// Protects against:
// - `../` path traversal
// - Absolute paths outside the workspace
// - Symlink escapes (both existing target symlinks and parent directory symlinks)
// - Sibling-prefix path confusion (e.g., `/workspace-evil` vs `/workspace`)
// - Cross-Origin / CSRF attacks and unbounded request bodies on the local HTTP server

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export class WorkspaceSecurityError extends Error {
  public readonly code = "WORKSPACE_SECURITY_VIOLATION";
  public readonly attemptedPath: string;
  public readonly workspaceRoot: string;

  constructor(message: string, attemptedPath: string, workspaceRoot: string) {
    super(message);
    this.name = "WorkspaceSecurityError";
    this.attemptedPath = attemptedPath;
    this.workspaceRoot = workspaceRoot;
  }
}

export class LocalApiSecurityError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "LocalApiSecurityError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeForComparison(p: string): string {
  const cleaned = resolve(p);
  return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
}

/**
 * Resolves the canonical real path of a workspace root on disk.
 */
export function resolveCanonicalWorkspaceRoot(workspacePath: string): string {
  const abs = resolve(workspacePath);
  if (existsSync(abs)) {
    try {
      return realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
    } catch {
      return abs;
    }
  }
  return abs;
}

/**
 * Finds the deepest existing ancestor directory and resolves its canonical `realpathSync`,
 * then re-attaches the remaining non-existent relative segments.
 */
function resolveCanonicalTargetWithMissingLeaf(targetAbs: string): string {
  const rootParsed = parse(targetAbs).root;
  let current = targetAbs;
  const trailingSegments: string[] = [];

  while (!existsSync(current) && current !== rootParsed) {
    const parent = dirname(current);
    if (parent === current) break;
    trailingSegments.unshift(current.slice(parent.length).replace(/^[/\\]+/, ""));
    current = parent;
  }

  let canonicalExisting = current;
  if (existsSync(current)) {
    canonicalExisting = realpathSync.native ? realpathSync.native(current) : realpathSync(current);
  }

  return trailingSegments.length > 0
    ? resolve(canonicalExisting, ...trailingSegments)
    : canonicalExisting;
}

function isStrictlyInsideOrEqual(canonicalRoot: string, canonicalCandidate: string): boolean {
  const normRoot = normalizeForComparison(canonicalRoot).replace(/[/\\]+$/, "");
  const normCand = normalizeForComparison(canonicalCandidate).replace(/[/\\]+$/, "");

  if (normCand === normRoot) return true;
  const rootWithSep = `${normRoot}${sep}`;
  return normCand.startsWith(rootWithSep);
}

/**
 * Enforces canonical workspace containment for every file/directory operation.
 * Rejects:
 * 1. Null bytes (`\0`)
 * 2. Absolute paths that resolve outside the workspace root
 * 3. `../` relative traversal outside the workspace root
 * 4. Sibling-prefix confusion (`/path/to/repo-evil` when workspace is `/path/to/repo`)
 * 5. Symlink escapes (both when the target itself is a symlink pointing outside the workspace
 *    and when an intermediate directory is a symlink pointing outside the workspace)
 */
export function assertCanonicalWorkspacePath(
  workspaceRoot: string,
  rawCandidatePath: string,
  options: { operation?: string } = {},
): string {
  const op = options.operation ?? "file_access";
  if (typeof rawCandidatePath !== "string" || rawCandidatePath.trim().length === 0) {
    throw new WorkspaceSecurityError(
      `[${op}] Empty or invalid path argument`,
      String(rawCandidatePath),
      workspaceRoot,
    );
  }
  if (rawCandidatePath.includes("\0")) {
    throw new WorkspaceSecurityError(
      `[${op}] Null byte in path is forbidden`,
      rawCandidatePath,
      workspaceRoot,
    );
  }

  const canonicalRoot = resolveCanonicalWorkspaceRoot(workspaceRoot);
  const platformCandidate =
    process.platform === "win32" ? rawCandidatePath.replace(/\//g, "\\") : rawCandidatePath;

  // Compute lexical resolution first
  const lexicalTarget = isAbsolute(platformCandidate)
    ? resolve(platformCandidate)
    : resolve(canonicalRoot, platformCandidate);

  if (!isStrictlyInsideOrEqual(canonicalRoot, lexicalTarget)) {
    throw new WorkspaceSecurityError(
      `[${op}] Path escapes canonical workspace boundary: "${rawCandidatePath}" is outside "${canonicalRoot}"`,
      rawCandidatePath,
      canonicalRoot,
    );
  }

  // Walk every prefix from canonicalRoot down to lexicalTarget to detect symlinks pointing outside
  const relFromRoot = relative(canonicalRoot, lexicalTarget);
  if (relFromRoot && !relFromRoot.startsWith("..")) {
    const parts = relFromRoot.split(/[/\\]+/).filter(Boolean);
    let cursor = canonicalRoot;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      if (existsSync(cursor)) {
        let st;
        try {
          st = lstatSync(cursor);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          let realLinkTarget: string;
          try {
            realLinkTarget = realpathSync.native ? realpathSync.native(cursor) : realpathSync(cursor);
          } catch {
            throw new WorkspaceSecurityError(
              `[${op}] Broken or unresolvable symlink blocked: "${rawCandidatePath}"`,
              rawCandidatePath,
              canonicalRoot,
            );
          }
          if (!isStrictlyInsideOrEqual(canonicalRoot, realLinkTarget)) {
            throw new WorkspaceSecurityError(
              `[${op}] Symlink escape blocked: "${rawCandidatePath}" resolves to "${realLinkTarget}" outside "${canonicalRoot}"`,
              rawCandidatePath,
              canonicalRoot,
            );
          }
        }
      }
    }
  }

  const canonicalTarget = resolveCanonicalTargetWithMissingLeaf(lexicalTarget);
  if (!isStrictlyInsideOrEqual(canonicalRoot, canonicalTarget)) {
    throw new WorkspaceSecurityError(
      `[${op}] Canonical realpath escape blocked: "${rawCandidatePath}" resolves to "${canonicalTarget}" outside "${canonicalRoot}"`,
      rawCandidatePath,
      canonicalRoot,
    );
  }

  return canonicalTarget;
}

// ============================================================================
// LOCAL API SECURITY (Origin Validation, Session/CSRF Token, Request Body Cap)
// ============================================================================

const SESSION_SECRET_TOKEN = process.env.APEX_SESSION_TOKEN || randomBytes(24).toString("hex");

export function getLocalSessionToken(): string {
  return SESSION_SECRET_TOKEN;
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

/**
 * Validates that an Origin header (if present) belongs strictly to a local loopback origin
 * or the Electron desktop shell (`file://`). Rejects cross-origin websites (`https://evil.com`).
 */
export function isAllowedLocalOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true; // Non-browser / same-origin GET or CLI calls without Origin
  const trimmed = originHeader.trim().toLowerCase();
  if (trimmed === "file://") return true;
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]")
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function safeTokenCompare(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Enforces loopback binding, Origin validation, and CSRF protection on HTTP requests.
 */
export function verifyLocalApiRequest(req: IncomingMessage): {
  allowedOriginHeader: string;
} {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    throw new LocalApiSecurityError(403, "NON_LOOPBACK_CLIENT", "Access restricted to loopback clients only.");
  }

  const origin = req.headers.origin;
  if (origin !== undefined && !isAllowedLocalOrigin(origin)) {
    throw new LocalApiSecurityError(
      403,
      "FORBIDDEN_ORIGIN",
      `Cross-origin request from "${origin}" is forbidden.`,
    );
  }

  const method = (req.method ?? "GET").toUpperCase();
  const isMutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";

  if (isMutating) {
    // Reject simple HTML form CSRF content-types (application/x-www-form-urlencoded, multipart/form-data, text/plain)
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    if (
      contentType.startsWith("application/x-www-form-urlencoded") ||
      contentType.startsWith("multipart/form-data") ||
      contentType.startsWith("text/plain")
    ) {
      throw new LocalApiSecurityError(
        415,
        "CSRF_UNSAFE_CONTENT_TYPE",
        `Mutating API endpoints require application/json; rejected Content-Type "${contentType}".`,
      );
    }

    // If a custom token header is supplied, verify it matches the session token
    const providedToken =
      (req.headers["x-apex-token"] as string | undefined) ??
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : undefined);

    if (providedToken !== undefined && providedToken.length > 0) {
      if (!safeTokenCompare(providedToken, SESSION_SECRET_TOKEN)) {
        throw new LocalApiSecurityError(401, "INVALID_SESSION_TOKEN", "Invalid X-Apex-Token or Bearer token.");
      }
    } else if (process.env.APEX_REQUIRE_TOKEN === "1") {
      throw new LocalApiSecurityError(401, "MISSING_SESSION_TOKEN", "X-Apex-Token is required.");
    }
  }

  const allowedOriginHeader =
    origin && isAllowedLocalOrigin(origin) ? origin : "http://127.0.0.1:5199";
  return { allowedOriginHeader };
}

/**
 * Reads and parses a JSON request body with a strict byte-size limit (default 1 MiB).
 */
export function readBoundedJsonBody<T>(
  req: IncomingMessage,
  maxBytes = 1_048_576,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        reject(
          new LocalApiSecurityError(
            413,
            "PAYLOAD_TOO_LARGE",
            `Request body exceeds maximum size of ${maxBytes} bytes.`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolvePromise((text ? JSON.parse(text) : {}) as T);
      } catch {
        reject(
          new LocalApiSecurityError(400, "INVALID_JSON", "Malformed JSON request body."),
        );
      }
    });

    req.on("error", (err) => {
      if (!aborted) reject(err);
    });
  });
}
