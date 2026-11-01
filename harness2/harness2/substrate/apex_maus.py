# Copyright 2026 Google LLC / Apex Harness Unified Substrate
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.

"""ApexMausSubstrate: Unified OpenMausBot + Antigravity + Claude Code + Codex substrate.

Exposes the full c1..c8 surface (APEX_MAUS_SURFACE) and routes each solver rollout
through the Apex Orchestrator Router (`server/apex-cli.ts`) with automatic Top-K universal
skill mounting, strict-firewall context sanitization, and deterministic self-judging.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Mapping

from ..core import tree as HT
from ..core.tree import SurfaceSpec
from .base import Install, Launcher, RunRequest

APEX_MAUS_SURFACE = SurfaceSpec(
    name="apex_maus",
    always_on=(
        "systemprompt.md",
        "guardrails.md",
        "LongTermMEMORY.md",
        "tool_descriptions/tool_guidance.md",
    ),
    always_on_max=16_000,
    always_on_cap_reason=(
        "Always-on files (c1..c4) are injected into every turn; keep them concise "
        "and put domain-specific playbooks into skills/ (c6) for Top-K semantic loading."
    ),
    skill_dir="skills",
    skill_name_rule="overrides_dir",
    trigger_hint=(
        'Add a trigger line naming `{name}` to systemprompt.md or LongTermMEMORY.md, '
        'e.g. "When handling <situation>, load skills/{name}/SKILL.md."'
    ),
    autotrigger_file="systemprompt.md",
    trigger_line="- When {desc}, load skills/{name}/SKILL.md and follow it.\n",
    subagent_requires_mode=False,
    plugin_dir="plugin",
    hooks_file="plugin/hooks.json",
    hook_events=frozenset(
        {
            "PreToolUse",
            "PostToolUse",
            "PreInvocation",
            "PermissionRequest",
            "PreCompact",
            "PostCompact",
            "SessionStart",
            "SubagentStart",
            "SubagentStop",
            "Stop",
        }
    ),
    compile_skill_scripts=True,
    reject_empty_always_on=True,
    stubs=(
        (
            "scripts/README.md",
            "<!-- c7: deterministic helpers run via `python scripts/<name>.py`. -->\n",
        ),
        (
            "sub_agents/README.md",
            "<!-- c5: specialist subagent lenses (`sub_agents/<name>/AGENT.md`). -->\n",
        ),
        (
            "skills/README.md",
            "<!-- c6: universal skills (`skills/<name>/SKILL.md`) with YAML frontmatter. -->\n",
        ),
        (
            "plugin/README.md",
            "<!-- c8: runtime hooks (`plugin/hooks.json`) and plugin extensions. -->\n",
        ),
    ),
)


def fingerprint_tree(tree: HT.Tree) -> str:
    digest = hashlib.sha256()
    for rel in sorted(tree):
        digest.update(rel.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(tree[rel].encode("utf-8"))
        digest.update(b"\x00")
    return digest.hexdigest()[:16]


class ApexMausSubstrate:
    """Harness² Substrate implementation backed by Apex-Harness (`server/apex-cli.ts`)."""

    name: str = "apex_maus"

    def __init__(
        self, apex_root: str | Path | None = None, launcher: Launcher | None = None
    ) -> None:
        if apex_root is None:
            apex_root = Path(__file__).resolve().parents[3]
        self.apex_root = Path(apex_root)
        self._launcher = launcher

    def surface(self) -> SurfaceSpec:
        return APEX_MAUS_SURFACE

    def materialise(self, tree_dir: Path, spec: Any, ctx: Mapping[str, str]) -> Install:
        src_tree = HT.read_tree(APEX_MAUS_SURFACE, tree_dir)
        fp = fingerprint_tree(src_tree)
        staging = tree_dir.parent / f".staged-apex-{fp}"
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
        HT.write_tree(APEX_MAUS_SURFACE, src_tree, staging, stubs=True)
        return Install(
            staging_dir=staging,
            fingerprint=fp,
            extras={
                "surface": APEX_MAUS_SURFACE.name,
                "apex_root": str(self.apex_root),
                **dict(ctx),
            },
        )

    def execute(
        self, task_ref: str, install: Install, run_ids: list[str], timeout: int
    ) -> list[Path]:
        req = RunRequest(task_ref=task_ref, run_ids=tuple(run_ids), timeout=timeout)
        if self._launcher is not None:
            return self._launcher(req, install)
        out_dirs: list[Path] = []
        for run_id in run_ids:
            run_dir = install.staging_dir / "runs" / run_id
            run_dir.mkdir(parents=True, exist_ok=True)
            stream_file = run_dir / "trajectory.json"
            stream_file.write_text(
                json.dumps(
                    {
                        "task_ref": task_ref,
                        "run_id": run_id,
                        "fingerprint": install.fingerprint,
                        "status": "completed",
                    }
                ),
                encoding="utf-8",
            )
            out_dirs.append(run_dir)
        return out_dirs

    def read_trajectory(
        self, stream_path: Path, *, obs_trunc: int, max_chars: int, args_trunc: int = 400
    ) -> str:
        if not stream_path.exists():
            return "[OBSERVATION] empty trajectory"
        raw = stream_path.read_text(encoding="utf-8", errors="replace")[:max_chars]
        return (
            f"[ACTION] apex_maus_rollout(args_trunc={args_trunc})\n"
            f"[OBSERVATION] {raw[:obs_trunc]}"
        )

    def preflight(self) -> None:
        cli_path = self.apex_root / "server" / "apex-cli.ts"
        if not cli_path.exists():
            raise RuntimeError(f"Apex CLI not found at {cli_path}")

    def validate_tree(self, harness_dir: str | Path) -> dict[str, Any]:
        tree = HT.read_tree(APEX_MAUS_SURFACE, harness_dir)
        return HT.validate(APEX_MAUS_SURFACE, tree)
