// Universal Multi-Format Tool Call & Reasoning Parser for Apex Harness.
// Synthesizes patterns from:
// - NousResearch/hermes-agent (`agent/turn_response_intake.py`, `agent/think_scrubber.py`)
// - lidge-jun/opencodex (`src/protocols`, `src/adapters`)
// - Twigpine/openclaude (`src/tools/TodoWriteTool`, `src/tools/RepoMapTool`)
// - anomalyco/opencode (`packages/session-ui/src/components/basic-tool.tsx`)
//
// Ensures NO raw `<tool_call>...` XML, `<invoke>...`, or `<think>...` tags ever leak into
// the user's chat bubble, and normalizes tool calls from any LLM family into executable actions.

export type CanonicalToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_search"
  | "list_dir"
  | "run_command"
  | "call_mcp_tool"
  | "todo_write"
  | "repo_map"
  | "delegate_subagent";

export interface ParsedAgentToolCall {
  rawMatch: string;
  tool: CanonicalToolName;
  originalToolName: string;
  path?: string;
  content?: string;
  target?: string;
  replacement?: string;
  startLine?: number;
  endLine?: number;
  pattern?: string;
  command?: string;
  serverName?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  todos?: Array<{ id?: string; content: string; status: "pending" | "in_progress" | "completed" }>;
  role?: string;
  task?: string;
  preferredModelId?: string;
  tokenBudget?: number;
}

export interface ScrubbedModelOutput {
  visibleText: string;
  cleanText: string;
  reasoningBlocks: string[];
  extractedThinking: string[];
  toolCalls: ParsedAgentToolCall[];
}

const TOOL_NAME_ALIAS_MAP: Record<string, CanonicalToolName> = {
  // Read file aliases
  read_file: "read_file",
  read: "read_file",
  fileread: "read_file",
  file_read: "read_file",
  view_file: "read_file",
  open_file: "read_file",
  cat: "read_file",
  // Write file aliases
  write_file: "write_file",
  write: "write_file",
  filewrite: "write_file",
  file_write: "write_file",
  create_file: "write_file",
  save_file: "write_file",
  // Edit file aliases
  edit_file: "edit_file",
  edit: "edit_file",
  fileedit: "edit_file",
  file_edit: "edit_file",
  str_replace: "edit_file",
  apply_patch: "edit_file",
  patch_file: "edit_file",
  replace_in_file: "edit_file",
  // Search / Grep aliases
  grep_search: "grep_search",
  grep: "grep_search",
  search_files: "grep_search",
  search_for_pattern: "grep_search",
  ripgrep: "grep_search",
  rg: "grep_search",
  find_in_files: "grep_search",
  // List directory / Glob aliases
  list_dir: "list_dir",
  listdir: "list_dir",
  list_files: "list_dir",
  list_directory: "list_dir",
  glob: "list_dir",
  ls: "list_dir",
  find_files: "list_dir",
  // Shell command aliases
  run_command: "run_command",
  bash: "run_command",
  shell: "run_command",
  powershell: "run_command",
  exec_command: "run_command",
  execute_command: "run_command",
  terminal: "run_command",
  cmd: "run_command",
  // MCP tool call aliases
  call_mcp_tool: "call_mcp_tool",
  mcp_tool: "call_mcp_tool",
  mcp: "call_mcp_tool",
  // OpenClaude TodoWrite & RepoMap
  todo_write: "todo_write",
  todowrite: "todo_write",
  todo_list: "todo_write",
  update_plan: "todo_write",
  repo_map: "repo_map",
  repomap: "repo_map",
  delegate_subagent: "delegate_subagent",
  subagent: "delegate_subagent",
  spawn_subagent: "delegate_subagent",
  invoke_subagent: "delegate_subagent",
};

export function normalizeCanonicalToolName(rawName: string): CanonicalToolName | null {
  const cleaned = (rawName || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (cleaned in TOOL_NAME_ALIAS_MAP) {
    return TOOL_NAME_ALIAS_MAP[cleaned]!;
  }
  // Check underscore-preserved version
  const snake = (rawName || "").trim().toLowerCase();
  if (snake in TOOL_NAME_ALIAS_MAP) {
    return TOOL_NAME_ALIAS_MAP[snake]!;
  }
  if (snake.includes("subagent") || snake.includes("delegate")) return "delegate_subagent";
  if (snake.includes("read") || snake.includes("view")) return "read_file";
  if (snake.includes("edit") || snake.includes("replace") || snake.includes("patch")) return "edit_file";
  if (snake.includes("write") || snake.includes("create")) return "write_file";
  if (snake.includes("grep") || snake.includes("search")) return "grep_search";
  if (snake.includes("list") || snake.includes("glob") || snake === "ls") return "list_dir";
  if (snake.includes("bash") || snake.includes("command") || snake.includes("exec") || snake.includes("shell")) {
    return "run_command";
  }
  if (snake.includes("todo") || snake.includes("plan")) return "todo_write";
  if (snake.includes("repomap") || snake.includes("repo_map")) return "repo_map";
  return null;
}

function buildParsedCallFromArgs(
  rawMatch: string,
  originalName: string,
  argsObj: Record<string, unknown>,
): ParsedAgentToolCall | null {
  const canonical = normalizeCanonicalToolName(originalName);
  if (!canonical) return null;

  const str = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const val = argsObj[k];
      if (typeof val === "string" && val.trim().length > 0) return val.trim();
    }
    return undefined;
  };
  const num = (keys: string[]): number | undefined => {
    for (const k of keys) {
      const val = argsObj[k];
      if (typeof val === "number" && Number.isFinite(val)) return val;
      if (typeof val === "string" && /^\d+$/.test(val.trim())) return Number(val.trim());
    }
    return undefined;
  };

  const pathVal = str(["path", "file_path", "filePath", "filepath", "file", "target_file", "directory", "dir", "relDir"]);
  const contentVal =
    typeof argsObj.content === "string"
      ? argsObj.content
      : typeof argsObj.file_text === "string"
        ? argsObj.file_text
        : typeof argsObj.text === "string"
          ? argsObj.text
          : undefined;
  const targetVal =
    typeof argsObj.target === "string"
      ? argsObj.target
      : typeof argsObj.old_str === "string"
        ? argsObj.old_str
        : typeof argsObj.old_string === "string"
          ? argsObj.old_string
          : typeof argsObj.search === "string"
            ? argsObj.search
            : undefined;
  const replacementVal =
    typeof argsObj.replacement === "string"
      ? argsObj.replacement
      : typeof argsObj.new_str === "string"
        ? argsObj.new_str
        : typeof argsObj.new_string === "string"
          ? argsObj.new_string
          : typeof argsObj.replace === "string"
            ? argsObj.replace
            : undefined;

  return {
    rawMatch,
    tool: canonical,
    originalToolName: originalName,
    path: pathVal,
    content: contentVal,
    target: targetVal,
    replacement: replacementVal,
    startLine: num(["startLine", "start_line", "offset", "line_start"]),
    endLine: num(["endLine", "end_line", "limit", "line_end"]),
    pattern: str(["pattern", "query", "regex", "search_term", "keyword"]),
    command: str(["command", "cmd", "script", "shell_command"]),
    serverName: str(["serverName", "server_name", "server"]),
    toolName: str(["toolName", "tool_name"]),
    args: (argsObj.args as Record<string, unknown> | undefined) ?? argsObj,
    todos: Array.isArray(argsObj.todos)
      ? (argsObj.todos as Array<{ id?: string; content: string; status: "pending" | "in_progress" | "completed" }>)
      : undefined,
    role: str(["role", "agentRole", "agent_role"]),
    task: str(["task", "prompt", "description", "instruction"]),
    preferredModelId: str(["preferredModelId", "model", "modelId", "model_id"]),
    tokenBudget: num(["tokenBudget", "token_budget", "budget"]),
  };
}

/**
 * Extracts reasoning blocks (`<think>...</think>`, `<thinking>...</thinking>`) and
 * all 6 LLM tool-call formats from an assistant response, returning clean human-readable
 * text plus structured tool calls ready for execution.
 */
export function parseAndScrubModelResponse(rawText: string): ScrubbedModelOutput {
  let working = rawText || "";
  const reasoningBlocks: string[] = [];
  const toolCalls: ParsedAgentToolCall[] = [];

  // 1. Extract <think> / <thinking> / <reasoning> blocks (Hermes think_scrubber pattern)
  const thinkRegex = /<(?:think|thinking|reasoning|thought)>([\s\S]*?)<\/(?:think|thinking|reasoning|thought)>/gi;
  working = working.replace(thinkRegex, (_full, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) reasoningBlocks.push(trimmed);
    return "";
  });

  // 2. Format A: Fenced ```apex-action ... ``` or ```tool_call ... ``` blocks
  const apexActionRegex = /```(?:apex-action|tool_call|tool-call)\r?\n([\s\S]*?)```/g;
  working = working.replace(apexActionRegex, (fullMatch, jsonBody: string) => {
    try {
      const parsed = JSON.parse(jsonBody.trim()) as Record<string, unknown>;
      const rawName = String(parsed.tool || parsed.name || parsed.function || "");
      const nestedArgs =
        typeof parsed.arguments === "object" && parsed.arguments !== null
          ? { ...parsed, ...(parsed.arguments as Record<string, unknown>) }
          : parsed;
      const call = buildParsedCallFromArgs(fullMatch, rawName, nestedArgs);
      if (call) {
        toolCalls.push(call);
        return "";
      }
    } catch {
      // Ignore malformed block
    }
    return fullMatch;
  });

  // 3. Format B: GLM / Poolside / Qwen / DeepSeek XML `<tool_call>...` blocks
  // Handles BOTH:
  //   - `<tool_call>read_file<arg_key>path</arg_key><arg_value>c:\...</arg_value></tool_call>`
  //   - `<tool_call>{"name":"read_file","arguments":{"path":"..."}}</tool_call>`
  const xmlToolCallRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  working = working.replace(xmlToolCallRegex, (fullMatch, inner: string) => {
    const body = inner.trim();

    // Case B1: `<tool_call>tool_name<arg_key>k</arg_key><arg_value>v</arg_value>...</tool_call>`
    if (body.includes("<arg_key>")) {
      const firstTagIdx = body.indexOf("<arg_key>");
      const toolName = body.slice(0, firstTagIdx).trim();
      const argsObj: Record<string, unknown> = {};
      const pairRegex = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/gi;
      let m: RegExpExecArray | null;
      while ((m = pairRegex.exec(body)) !== null) {
        const key = (m[1] || "").trim();
        const val = (m[2] || "").trim();
        if (key) argsObj[key] = val;
      }
      const call = buildParsedCallFromArgs(fullMatch, toolName, argsObj);
      if (call) {
        toolCalls.push(call);
        return "";
      }
    }

    // Case B2: `<tool_call>{"name":"read_file","arguments":{"path":"..."}}</tool_call>`
    try {
      const jsonStart = body.indexOf("{");
      const jsonEnd = body.lastIndexOf("}");
      if (jsonStart >= 0 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(body.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
        const rawName = String(parsed.name || parsed.tool || parsed.function || body.slice(0, jsonStart).trim());
        const nestedArgs =
          typeof parsed.arguments === "object" && parsed.arguments !== null
            ? { ...parsed, ...(parsed.arguments as Record<string, unknown>) }
            : typeof parsed.parameters === "object" && parsed.parameters !== null
              ? { ...parsed, ...(parsed.parameters as Record<string, unknown>) }
              : parsed;
        const call = buildParsedCallFromArgs(fullMatch, rawName, nestedArgs);
        if (call) {
          toolCalls.push(call);
          return "";
        }
      }
    } catch {
      // Ignore
    }

    return "";
  });

  // 4. Format C: Unclosed trailing `<tool_call>read_file<arg_key>path</arg_key><arg_value>...` (if stream truncated closing tag)
  const unclosedToolCallRegex = /<tool_call>\s*([a-zA-Z0-9_-]+)\s*<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)(?:<\/arg_value>|$)/gi;
  working = working.replace(unclosedToolCallRegex, (fullMatch, tName: string, k: string, v: string) => {
    const cleanVal = v.replace(/<\/tool_call>/gi, "").trim();
    const call = buildParsedCallFromArgs(fullMatch, tName.trim(), { [k.trim()]: cleanVal });
    if (call) {
      toolCalls.push(call);
      return "";
    }
    return "";
  });

  // 5. Format D: Anthropic / Claude XML `<function_calls><invoke name="..."><parameter name="...">...</parameter></invoke></function_calls>`
  const claudeInvokeRegex = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>/gi;
  working = working.replace(claudeInvokeRegex, (fullMatch, invokeName: string, innerParams: string) => {
    const argsObj: Record<string, unknown> = {};
    const paramRegex = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    let pm: RegExpExecArray | null;
    while ((pm = paramRegex.exec(innerParams)) !== null) {
      const pKey = (pm[1] || "").trim();
      const pVal = (pm[2] || "").trim();
      if (pKey) argsObj[pKey] = pVal;
    }
    const call = buildParsedCallFromArgs(fullMatch, invokeName, argsObj);
    if (call) {
      toolCalls.push(call);
      return "";
    }
    return "";
  });
  working = working.replace(/<\/?function_calls>/gi, "");

  const trimmed = working.trim();
  return {
    visibleText: trimmed,
    cleanText: trimmed,
    reasoningBlocks,
    extractedThinking: reasoningBlocks,
    toolCalls,
  };
}
