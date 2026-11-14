"""Top-level convenience bridge for Harness² ApexMausSubstrate surface validation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from harness2.substrate.apex_maus import APEX_MAUS_SURFACE, ApexMausSubstrate


def validate_all_surfaces(harness_dir: str | Path | None = None) -> dict[str, Any]:
    sub = ApexMausSubstrate()
    surface_spec = sub.surface()
    surfaces = list(surface_spec.always_on) + [
        surface_spec.skill_dir,
        surface_spec.plugin_dir,
        "sub_agents",
        "scripts",
    ]
    result: dict[str, Any] = {
        "valid": len(surfaces) == 8 and surface_spec.name == "apex_maus",
        "surface_count": len(surfaces),
        "surfaces": surfaces,
    }
    if harness_dir is not None:
        target = Path(harness_dir)
        if target.exists():
            result["census"] = sub.validate_tree(target)
    return result


__all__ = ["APEX_MAUS_SURFACE", "ApexMausSubstrate", "validate_all_surfaces"]
