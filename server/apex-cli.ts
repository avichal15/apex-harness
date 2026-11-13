// Unified Apex-Harness CLI & Orchestration Entrypoint (`node --experimental-strip-types server/apex-cli.ts`).
// Combines OpenMausBot's multi-CLI driver spine, Universal Multi-IDE Skill/MCP Transpiler,
// AutoTune EMA Task-to-Model Router, Self-Judging Gate, Carbon Clean-Room Sanitizer, and Harness² (c1..c8).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOrchestrationPlan,
  evaluateCompletedTurn,
  loadScoreboard,
} from "./decider/apex-orchestrator-router.ts";
import {
  ensureCleanCarbonHome,
  loadUnifiedModelFleet,
  sanitizeForStrictModel,
  syncUnifiedModelRegistryToDisk,
  type DriverBackend,
  type ModelDomain,
} from "./harness/apex-fleet-sync.ts";
import {
  ensureHarness2TreeInitialized,
  recordHarness2Reflection,
  validateHarness2TreeViaPython,
} from "./harness/harness2-bridge.ts";
import {
  discoverAllUniversalMcpServers,
  discoverAllUniversalSkills,
  selectTopKSkillsForTurn,
  transpileSkillForDriver,
} from "./harness/universal-skill-loader.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const APEX_PROJECT_ROOT = resolve(HERE, "..");
export const APEX_DATA_DIR = process.env.APEX_DATA_DIR
  ? resolve(process.env.APEX_DATA_DIR)
  : join(APEX_PROJECT_ROOT, "data");

function getArg(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export function runApexCli(argv: readonly string[] = process.argv.slice(2)): number {
  const command = argv[0] ?? "status";
  const jsonOut = hasFlag(argv, "--json");

  if (command === "status") {
    const synced = syncUnifiedModelRegistryToDisk(APEX_DATA_DIR);
    const cleanCarbonHome = ensureCleanCarbonHome(APEX_DATA_DIR);
    const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });
    const mcpServers = discoverAllUniversalMcpServers();
    const scoreboard = loadScoreboard(APEX_DATA_DIR, synced.models);
    const h2Tree = ensureHarness2TreeInitialized(APEX_DATA_DIR);
    const h2Validation = validateHarness2TreeViaPython(APEX_PROJECT_ROOT, APEX_DATA_DIR);

    const byEcosystem: Record<string, number> = {};
    for (const s of skills) {
      byEcosystem[s.ecosystem] = (byEcosystem[s.ecosystem] ?? 0) + 1;
    }

    const summary = {
      projectRoot: APEX_PROJECT_ROOT,
      dataDir: APEX_DATA_DIR,
      fleetCount: synced.count,
      registryPath: synced.path,
      cleanCarbonHome,
      universalSkillsTotal: skills.length,
      skillsByEcosystem: byEcosystem,
      universalMcpServersTotal: mcpServers.length,
      mcpServers: mcpServers.map((m) => ({ name: m.name, ecosystem: m.ecosystem })),
      scoreboardPath: join(APEX_DATA_DIR, "apex-model-scoreboard.json"),
      topModelsByEma: Object.values(scoreboard.entries)
        .sort((a, b) => b.emaScore - a.emaScore)
        .slice(0, 8)
        .map((e) => ({ modelId: e.modelId, emaScore: e.emaScore })),
      harness2: {
        treeRoot: h2Tree.rootDir,
        initialized: h2Tree.initialized,
        pythonValidation: h2Validation,
      },
    };

    if (jsonOut) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log("=== APEX HARNESS (OpenMausBot + Harness² + Universal IDE Bridge) ===");
      console.log(`Project Root        : ${summary.projectRoot}`);
      console.log(`Data Directory      : ${summary.dataDir}`);
      console.log(`Unified Model Fleet : ${summary.fleetCount} models synced -> ${summary.registryPath}`);
      console.log(`Carbon Clean-Room   : ${summary.cleanCarbonHome}`);
      console.log(`Universal Skills    : ${summary.universalSkillsTotal} discovered (${JSON.stringify(summary.skillsByEcosystem)})`);
      console.log(`Universal MCPs      : ${summary.universalMcpServersTotal} servers (${summary.mcpServers.map((m) => m.name).join(", ")})`);
      console.log(`Harness² (c1..c8)   : ${h2Validation.details}`);
      console.log("\nTop Ranked Models (EMA Scoreboard):");
      for (const m of summary.topModelsByEma) {
        console.log(`  - ${m.modelId.padEnd(36)} EMA=${m.emaScore}`);
      }
    }
    return 0;
  }

  if (command === "route") {
    const prompt = getArg(argv, "--prompt") ?? "Design and implement a full-stack React dashboard with SQLite backend.";
    const workspace = getArg(argv, "--workspace") ?? APEX_PROJECT_ROOT;
    const preferredModelId = getArg(argv, "--model");
    const plan = buildOrchestrationPlan(prompt, {
      dataDir: APEX_DATA_DIR,
      workspaceRoot: workspace,
      preferredModelId,
    });

    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, plan }));
    } else {
      console.log(`=== APEX ORCHESTRATION PLAN ===`);
      console.log(`Primary Domain      : ${plan.classification.primaryDomain} (complexity=${plan.classification.complexity})`);
      console.log(`Selected Model      : ${plan.primaryModel.id} [${plan.primaryModel.displayName}] (driver=${plan.primaryModel.driver})`);
      console.log(`Fallback Chain      : ${plan.fallbackModels.map((m) => m.id).join(" -> ")}`);
      console.log(`Council Reviewers   : ${plan.councilReviewers.map((m) => m.id).join(", ")}`);
      console.log(`Strict Sanitized    : ${plan.strictSanitized} (redactions=${plan.redactionsCount})`);
      console.log(
        `Mounted Top-K Skills: ${plan.mountedSkills.map((s) => `${s.name} (${s.ecosystem}, score=${s.score})`).join(", ") || "none"}`,
      );
    }
    return 0;
  }

  if (command === "skills") {
    const query = getArg(argv, "--query") ?? "";
    const driver = (getArg(argv, "--driver") ?? "antigravity") as DriverBackend;
    const strict = hasFlag(argv, "--strict-firewall");
    const skills = discoverAllUniversalSkills({ workspaceRoot: APEX_PROJECT_ROOT });

    if (query) {
      const matched = selectTopKSkillsForTurn(query, skills, {
        topK: 5,
        strictFirewall: strict,
        targetDriver: driver,
      });
      if (jsonOut) {
        console.log(JSON.stringify({ query, driver, matched }, null, 2));
      } else {
        console.log(`Top ${matched.length} skills for query="${query}" (transpiled for driver=${driver}):`);
        for (const item of matched) {
          console.log(`  - [${item.skill.ecosystem}] ${item.skill.name} (score=${item.score})`);
        }
        if (matched[0]) {
          console.log("\n--- Transpiled Top Skill Preview ---");
          console.log(matched[0].transpiledPromptBlock.slice(0, 600));
        }
      }
      return 0;
    }

    const transpileName = getArg(argv, "--transpile");
    if (transpileName) {
      const target = skills.find((s) => s.name.toLowerCase() === transpileName.toLowerCase());
      if (!target) {
        console.error(`Skill not found: ${transpileName}`);
        return 1;
      }
      console.log(transpileSkillForDriver(target, driver));
      return 0;
    }

    console.log(`Discovered ${skills.length} universal skills/commands/subagents/rules.`);
    return 0;
  }

  if (command === "judge") {
    const modelId = getArg(argv, "--model") ?? "agy-acp/gemini-4-argon-high";
    const domain = (getArg(argv, "--domain") ?? "surgical_code") as ModelDomain;
    const responseText = getArg(argv, "--response") ?? "export function calculateTotal(items: number[]): number { return items.reduce((a, b) => a + b, 0); }";
    const lintErr = getArg(argv, "--lint-error");
    const verdict = evaluateCompletedTurn({
      dataDir: APEX_DATA_DIR,
      modelId,
      domain,
      responseText,
      linterErrors: lintErr ? [lintErr] : [],
    });

    const lesson = getArg(argv, "--lesson");
    if (lesson) {
      recordHarness2Reflection(APEX_DATA_DIR, {
        timestamp: new Date().toISOString(),
        taskSummary: `Evaluated ${domain} turn on ${modelId}`,
        domain,
        modelId,
        passed: verdict.passed,
        score: verdict.score,
        lessonLearned: lesson,
        antibodyRule: getArg(argv, "--antibody"),
      });
    }

    if (jsonOut) {
      console.log(JSON.stringify(verdict, null, 2));
    } else {
      console.log(`Self-Judge Verdict: passed=${verdict.passed}, score=${verdict.score}, action=${verdict.recommendedAction}`);
      if (verdict.issues.length) {
        console.log(`Issues: ${verdict.issues.join(" | ")}`);
      }
    }
    return 0;
  }

  if (command === "sanitize") {
    const text = getArg(argv, "--text") ?? "Check CVE-2026-21858 and run aircrack-ng / red-team exploit validation.";
    const res = sanitizeForStrictModel(text);
    const cleanHome = ensureCleanCarbonHome(APEX_DATA_DIR);
    console.log(JSON.stringify({ ...res, cleanHome }, null, 2));
    return 0;
  }

  if (command === "evolve") {
    ensureHarness2TreeInitialized(APEX_DATA_DIR);
    const validation = validateHarness2TreeViaPython(APEX_PROJECT_ROOT, APEX_DATA_DIR);
    console.log(JSON.stringify(validation, null, 2));
    return validation.ok ? 0 : 1;
  }

  const fleet = loadUnifiedModelFleet();
  console.log(`Unknown command "${command}". Available commands: status, route, skills, judge, sanitize, evolve. (${fleet.length} models loaded)`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runApexCli();
}
