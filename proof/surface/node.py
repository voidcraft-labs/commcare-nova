"""Running the surface's JavaScript helpers (proof/surface/js) under the image's Node."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from proof.surface.model import SurfaceError

JS = Path(__file__).resolve().parent / "js"
TOOLS = Path(os.environ.get("PROOF_TOOLS", "/opt/proof-tools"))
DEADLINE_SECONDS = 600


def run_node(command: str, arguments: list[str], *, script: str = "surface.mjs", stdin: Any = None) -> Any:
    """Runs ``node js/<script> <command> <arguments>`` and returns the JSON it prints."""
    environment = {**os.environ, "PROOF_TOOLS": str(TOOLS)}
    try:
        finished = subprocess.run(
            ["node", str(JS / script), command, *arguments],
            input=None if stdin is None else json.dumps(stdin).encode("utf-8"),
            capture_output=True,
            timeout=DEADLINE_SECONDS,
            env=environment,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SurfaceError(f"The surface extractor could not run its {script} {command} helper ({error}).") from error
    if finished.returncode != 0:
        raise SurfaceError(
            f"The surface extractor's {script} {command} helper failed (exit {finished.returncode}):\n"
            + finished.stderr.decode("utf-8", "replace")[-4000:]
        )
    try:
        return json.loads(finished.stdout)
    except ValueError as error:
        raise SurfaceError(
            f"The surface extractor's {script} {command} helper printed something that is not JSON ({error})."
        ) from error
