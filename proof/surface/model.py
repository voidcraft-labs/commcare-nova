"""The surface's items, where each family reads them from, and how they are written.

An item is one thing an upstream accepts in an app, keyed ``<family>:<name>``
(the family grammars are in ``proof/surface/__init__.py``). It carries the
facts whose change matters and ``source``, the upstream-relative places it was
read from (``commcare-hq/<path>::<symbol>``). The surface is written as one
JSON document with sorted keys, tab indentation and no timestamps or absolute
paths, so the same pins always give the same bytes.
"""

from __future__ import annotations

import json
import math
import os
import re
import subprocess
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# The key grammar every family shares, as the manifest's schema checks it
# (lib/commcare/surface/schema.ts, surfaceKeySchema): a lowercase family, a
# colon, and a name without whitespace.
KEY_PATTERN = re.compile(r"^[a-z][a-z0-9-]*:\S+$")

# The upstream repositories, by the names proof/pins.json gives them.
HQ = "commcare-hq"
CORE = "commcare-core"
ANDROID = "commcare-android"


class SurfaceError(Exception):
    """The extractor met an upstream shape it cannot read faithfully."""


@dataclass(frozen=True)
class Sources:
    """Where each upstream checkout, and the extractor's tools, live."""

    hq: Path = Path(os.environ.get("PROOF_HQ", "/opt/hq"))
    core: Path = Path(os.environ.get("PROOF_CORE", "/opt/core"))
    android: Path = Path(os.environ.get("PROOF_ANDROID", "/opt/android"))
    tools: Path = Path(os.environ.get("PROOF_TOOLS", "/opt/proof-tools"))
    # The image's editor build (proof/image/editors/build.mjs), whose Vellum host
    # page the Vellum family opens; the editor driver reads the same directory.
    editors: Path = Path(os.environ.get("PROOF_EDITORS", "/opt/editors"))

    def relative(self, path: Path) -> str:
        """``path`` as ``<repository>/<path inside it>``, for an item's source."""
        path = Path(path).resolve()
        for name, root in ((HQ, self.hq), (CORE, self.core), (ANDROID, self.android)):
            try:
                return f"{name}/{path.relative_to(Path(root).resolve()).as_posix()}"
            except ValueError:
                continue
        # A file outside the checkouts (a test's planted copy) is named by its
        # file name alone, so no absolute path reaches the surface.
        return path.name

    def pins(self) -> dict[str, str]:
        """The commit each checkout is at."""
        pins = {}
        for name, root in ((HQ, self.hq), (CORE, self.core), (ANDROID, self.android)):
            try:
                pins[name] = subprocess.run(
                    ["git", "-C", str(root), "rev-parse", "HEAD"],
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout.strip()
            except (OSError, subprocess.CalledProcessError) as error:
                raise SurfaceError(
                    f"The surface extractor could not read the commit of {name} at {root} ({error}). "
                    "It records the pins it read, so each checkout must be a git checkout."
                ) from error
        return pins


@dataclass
class Item:
    key: str
    source: tuple[str, ...]
    facts: dict[str, Any] = field(default_factory=dict)


def item(key: str, source: str | Iterable[str], **facts: Any) -> Item:
    sources = (source,) if isinstance(source, str) else tuple(source)
    return Item(key, tuple(sorted(set(sources))), facts)


class Surface:
    """The items of every family, refusing a malformed or repeated key."""

    def __init__(self):
        self.items: dict[str, Item] = {}

    def add(self, new: Item) -> None:
        if not KEY_PATTERN.match(new.key):
            raise SurfaceError(
                f"The surface extractor made the key {new.key!r}, which is not `<family>:<name>` "
                "with a lowercase family and no whitespace in the name. Its family's grammar "
                "(proof/surface/__init__.py) needs to say how to spell this item."
            )
        if "source" in new.facts:
            raise SurfaceError(f"The item {new.key} names a fact `source`, which is reserved for where it was read.")
        if new.key in self.items:
            raise SurfaceError(
                f"Two items of the surface share the key {new.key}. A family's grammar must name each "
                "item once; the second came from " + ", ".join(new.source) + "."
            )
        self.items[new.key] = new

    def extend(self, items: Iterable[Item]) -> None:
        for one in items:
            self.add(one)

    def document(self, pins: Mapping[str, str]) -> dict[str, Any]:
        return {
            "pins": dict(pins),
            "items": {key: {"source": list(one.source), **one.facts} for key, one in self.items.items()},
        }


def canonical(value: Any, where: str = "surface") -> Any:
    """``value`` as plain JSON, refusing anything that would not print the same way twice."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise SurfaceError(f"{where} holds the number {value!r}, which JSON cannot carry.")
        return value
    if isinstance(value, Mapping):
        out = {}
        for key, inner in value.items():
            if not isinstance(key, str):
                raise SurfaceError(f"{where} has a key {key!r} that is not a string.")
            out[key] = canonical(inner, f"{where}.{key}")
        return out
    if isinstance(value, (list, tuple)):
        return [canonical(inner, f"{where}[]") for inner in value]
    raise SurfaceError(
        f"{where} holds a {type(value).__name__} ({value!r}), which the surface cannot print "
        "deterministically. The family that made it must reduce it to JSON."
    )


def dumps(document: Mapping[str, Any]) -> str:
    return json.dumps(canonical(document), indent="\t", sort_keys=True, ensure_ascii=False) + "\n"
