"""One extraction of the whole surface, from the checkouts at their pins."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from proof.surface.families import (
    app_schema,
    authored,
    data,
    evaluation,
    flags,
    formats,
    hashtags,
    hq_api,
    profile,
    registries,
    runtime,
    search,
    strings,
    vellum,
    version_gates,
    xforms,
)
from proof.surface.hqboot import reading_code
from proof.surface.java import read_families
from proof.surface.model import Sources, Surface, dumps

# The Java helper's commands the families run over the pinned checkouts, read in one JVM before they run.
JAVA_COMMANDS = ("wide", "javarosa", "parsers", "appearances", "xforms", "session", "instance-sources", "xpath-grammar")

# In the order they run; each module's docstring holds its families' key grammars.
FAMILIES = (
    app_schema,
    formats,
    flags,
    version_gates,
    registries,
    profile,
    data,
    search,
    hashtags,
    hq_api,
    vellum,
    runtime,
    xforms,
    evaluation,
    strings,
    authored,
)


@dataclass
class Extraction:
    text: str
    items: int
    seconds: dict[str, float] = field(default_factory=dict)


def extract(sources: Sources | None = None) -> Extraction:
    sources = sources or Sources()
    started = time.perf_counter()
    surface = Surface()
    seconds: dict[str, float] = {}
    pins = sources.pins()
    with reading_code():
        seconds["boot"] = round(time.perf_counter() - started, 2)
        began = time.perf_counter()
        read_families(sources, list(JAVA_COMMANDS))
        seconds["java"] = round(time.perf_counter() - began, 2)
        for family in FAMILIES:
            began = time.perf_counter()
            surface.extend(family.extract(sources))
            seconds[family.__name__.rsplit(".", 1)[-1]] = round(time.perf_counter() - began, 2)
    text = dumps(surface.document(pins))
    seconds["total"] = round(time.perf_counter() - started, 2)
    return Extraction(text=text, items=len(surface.items), seconds=seconds)
