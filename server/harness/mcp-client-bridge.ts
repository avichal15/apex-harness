/**
 * Universal JSON-RPC 2.0 MCP Client Bridge (`server/harness/mcp-client-bridge.ts`)
 *
 * Connects to any of the 15 discovered MCP servers (from Antigravity, Claude Code,
 * Cursor, and Gemini CLI) over stdio or HTTP JSON-RPC 2.0 to list tools (`tools/list`)
 * and execute tool calls (`tools/call`) with cooperative timeout enforcement.
 */

import { spawn } from "node:child_process";
import { discoverAllUniversalMcpServers, type UniversalMcpServerEntry } from "./universal-skill-loader.ts";
import { runWithToolTimeout } from "./deepseek-subsystems.ts";

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  ok: boolean;
  serverName: string;
  toolName: string;
  content: string;
  isError?: boolean;
  durationMs: number;
}

/**
 * Sends a JSON-RPC 2.0 request sequence (`initialize` -> `notifications/initialized` -> method)
 * to a stdio MCP server and resolves the response for request id `2`.
 */
async function runStdioMcpRpc(
  server: UniversalMcpServerEntry,
  method: "tools/list" | "tools/call",
  params: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  if (!server.command) {
    throw new Error(`MCP server '${server.name}' has no stdio command configured.`);
  }

  const outcome = await runWithToolTimeout(async (signal) => {
    return await new Promise<unknown>((resolvePromise, rejectPromise) => {
      const child = spawn(server.command!, server.args ?? [], {
        env: {
          ...process.env,
          ...(server.env ?? {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(server.command!),
      });

      let stdoutBuf = "";
      let settled = false;

      const cleanup = () => {
        if (!child.killed) {
          try {
            child.kill();
          } catch {
            // Ignore kill race
          }
        }
      };

      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          if (!settled) {
            settled = true;
            rejectPromise(new Error("MCP stdio request aborted by timeout"));
          }
        },
        { once: true },
      );

      child.on("error", (err) => {
        cleanup();
        if (!settled) {
          settled = true;
          rejectPromise(err);
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const msg = JSON.parse(trimmed) as {
              id?: number;
              result?: unknown;
              error?: { message?: string };
            };
            if (msg.id === 1) {
              // Initialized; send notifications/initialized + target method (id: 2)
              const notif = JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              });
              const req2 = JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method,
                params,
              });
              child.stdin.write(`${notif}\n${req2}\n`);
            } else if (msg.id === 2) {
              settled = true;
              cleanup();
              if (msg.error) {
                rejectPromise(new Error(msg.error.message || "MCP RPC error"));
              } else {
                resolvePromise(msg.result);
              }
              return;
            }
          } catch {
            // Ignore non-JSON stdout line
          }
        }
      });

      child.on("close", (code) => {
        if (!settled) {
          settled = true;
          rejectPromise(new Error(`MCP server '${server.name}' exited before responding (code ${code})`));
        }
      });

      const initReq = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "apex-harness", version: "2.0.0" },
        },
      });
      child.stdin.write(`${initReq}\n`);
    });
  }, timeoutMs);

  if (!outcome.ok) {
    throw new Error(outcome.error?.message ?? `MCP call to '${server.name}' failed`);
  }
  return outcome.value;
}

/**
 * Lists available tools from a discovered MCP server.
 */
export async function listMcpServerTools(
  serverOrName: string | UniversalMcpServerEntry,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; serverName: string; tools: McpToolSchema[]; error?: string }> {
  const servers = discoverAllUniversalMcpServers();
  const server =
    typeof serverOrName === "string"
      ? servers.find((s) => s.name.toLowerCase() === serverOrName.toLowerCase())
      : serverOrName;
  const serverName = typeof serverOrName === "string" ? serverOrName : serverOrName.name;
  if (!server) {
    return {
      ok: false,
      serverName,
      tools: [],
      error: `MCP server '${serverName}' not found in universal registry.`,
    };
  }

  try {
    if (server.url) {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const data = (await res.json()) as { result?: { tools?: McpToolSchema[] } };
      return {
        ok: true,
        serverName: server.name,
        tools: data.result?.tools ?? [],
      };
    }

    const res = (await runStdioMcpRpc(server, "tools/list", {}, timeoutMs)) as {
      tools?: McpToolSchema[];
    };
    return {
      ok: true,
      serverName: server.name,
      tools: res?.tools ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      serverName: server.name,
      tools: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Invokes a tool on any discovered MCP server via JSON-RPC 2.0 (`tools/call`).
 */
export async function callMcpServerTool(
  arg1:
    | string
    | UniversalMcpServerEntry
    | {
        serverName: string;
        toolName: string;
        args?: Record<string, unknown>;
        timeoutMs?: number;
      },
  toolNameArg?: string,
  argsArg?: Record<string, unknown>,
  timeoutMsArg?: number,
): Promise<McpToolCallResult> {
  const t0 = Date.now();
  const servers = discoverAllUniversalMcpServers();
  const isOptionsObj =
    typeof arg1 === "object" && arg1 !== null && "toolName" in arg1 && !("command" in arg1);
  const serverName = isOptionsObj
    ? (arg1 as { serverName: string }).serverName
    : typeof arg1 === "string"
      ? arg1
      : (arg1 as UniversalMcpServerEntry).name;
  const toolName = isOptionsObj ? (arg1 as { toolName: string }).toolName : toolNameArg || "";
  const toolArgs = isOptionsObj
    ? ((arg1 as { args?: Record<string, unknown> }).args ?? {})
    : (argsArg ?? {});
  const timeoutMs = isOptionsObj
    ? ((arg1 as { timeoutMs?: number }).timeoutMs ?? 12_000)
    : (timeoutMsArg ?? 12_000);

  const server =
    typeof arg1 === "object" && arg1 !== null && "command" in arg1
      ? (arg1 as UniversalMcpServerEntry)
      : servers.find((s) => s.name.toLowerCase() === serverName.toLowerCase());

  if (!server) {
    return {
      ok: false,
      serverName,
      toolName,
      content: `MCP server '${serverName}' is not registered. Available: ${servers.map((s) => s.name).join(", ")}`,
      isError: true,
      durationMs: Date.now() - t0,
    };
  }

  try {
    let rawResult: unknown;
    if (server.url) {
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: toolArgs },
        }),
      });
      const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) throw new Error(json.error.message || "HTTP MCP error");
      rawResult = json.result;
    } else {
      rawResult = await runStdioMcpRpc(
        server,
        "tools/call",
        { name: toolName, arguments: toolArgs },
        timeoutMs,
      );
    }

    const formatted =
      typeof rawResult === "object" &&
      rawResult !== null &&
      "content" in rawResult &&
      Array.isArray((rawResult as { content: unknown[] }).content)
        ? (rawResult as { content: Array<{ type?: string; text?: string }> }).content
            .map((c) => c.text ?? JSON.stringify(c))
            .join("\n")
        : JSON.stringify(rawResult, null, 2);

    return {
      ok: true,
      serverName: server.name,
      toolName,
      content: formatted,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      serverName: server.name,
      toolName,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
      durationMs: Date.now() - t0,
    };
  }
}
