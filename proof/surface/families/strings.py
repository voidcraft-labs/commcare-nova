"""The UI string ids CommCare's runtimes read and HQ's build emits, which an app's translations may override.

Keys:

- ``ui-string:<id>``: each id in a UI string catalog or read by a runtime's
  code, with ``catalogs`` (the catalogs that hold it), ``hqBuildVersions``,
  ``readBy`` (the readers whose code reads it: ``core``, ``android``, ``cli``)
  and ``patterns`` (the reads whose id the reader names only in part that it
  fits), never the text, which is the catalogs' to change.

  - Android's catalogs (``app/assets/locales``), parsed with Core's own locale
    file parser (``LocalizationUtils.parseLocaleInput``).
  - HQ's CommCare catalogs (``submodules/commcare-translations``), each one
    HQ's own loader (``commcare_translations.load_translations``, through
    ``get_translation_file_paths``) can select: the loader is run for every
    language a catalog file names, at catalog versions 1 and 2 (``app_strings.py``'s
    ``dump-known`` and ``select-known`` strategies; ``ui_translations`` reads
    version 2), with no build version, ``latest``, and the version each
    historical catalog is named for, and the file it opens is recorded by the
    name the loader opens it by (``messages_en-2.txt`` is a link to the newest
    historical catalog; HQ selects it by its own name). A
    current catalog (``messages_<lang>-<n>.txt``) is listed in ``catalogs``; the
    English historical catalogs (``historical-translations-by-version/<version>-messages_en-2.txt``),
    which HQ's build selects by the app's build version, are listed in
    ``hqBuildVersions`` as runs ``<first>..<last>`` of consecutive selectable
    versions (a lone version as itself) whose catalog holds the id. A
    historical catalog no input selects (``2.36.0``, whose version the loader
    spells ``2.36``) is not HQ's to emit and is left out.
  - ``id_strings.REGEX_DEFAULT_VALUES``, which ``AppStringsBase.get_default_translations``
    adds to every catalog HQ loads.
  - The reads in Core's and Android's code (the Java helper's ``UiStrings``):
    ``Localization.get`` and ``Localization.getWithDefault`` in Java and
    Kotlin and ``@UiElement(locale = ...)``, each id followed back through
    locals, fields, parameters (to every caller's argument), returns, enum
    constants, maps, arrays and Android's resource names. A read whose id the
    reader names only in part (``android.package.name.*``) is a pattern; each
    catalog id it fits records the pattern and its reader.

- ``ui-string:<pattern>``: each such pattern (``*`` stands for the part the
  reader cannot name, so ``ui-string:*`` is every read whose id is not in the
  code at all, such as Core's reads of ids an app's suite names), with
  ``pattern: true``, its readers and where each read is.
"""

from __future__ import annotations

import inspect
import os
from pathlib import Path

from proof.surface.families.data import name
from proof.surface.java import run_java
from proof.surface.model import Item, Sources, SurfaceError, item

TRANSLATIONS = "submodules/commcare-translations"
HISTORICAL = "historical-translations-by-version"


def extract(sources: Sources) -> list[Item]:
    return ui_strings(sources)


def ui_strings(
    sources: Sources, core: Path | None = None, android: Path | None = None, hq: Path | None = None
) -> list[Item]:
    from corehq.apps.app_manager import id_strings

    read = run_java(sources, "wide", core, android)["uiStrings"]
    ids: dict[str, dict] = {}

    def add(identifier: str, where: str | None, fact: str, value) -> None:
        entry = ids.setdefault(identifier, {"source": set()})
        if where:
            entry["source"].add(where)
        entry.setdefault(fact, set()).add(value)

    for catalog, keys in read["catalogs"].items():
        for key in keys:
            add(key, catalog, "catalogs", catalog)
    current, historical = hq_catalogs(sources, (hq or sources.hq) / TRANSLATIONS)
    for catalog, keys in current.items():
        for key in keys:
            add(key, catalog, "catalogs", catalog)
    versions = sorted(historical, key=_version)
    for key in sorted({key for _, keys in historical.values() for key in keys}):
        for run in _runs([key in historical[version][1] for version in versions], versions):
            add(key, f"commcare-hq/{TRANSLATIONS}/{HISTORICAL}", "hqBuildVersions", run)
    regex_defaults = f"{sources.relative(inspect.getsourcefile(id_strings))}::REGEX_DEFAULT_VALUES"
    for key in id_strings.REGEX_DEFAULT_VALUES:
        add(key, regex_defaults, "catalogs", "commcare-hq id_strings.REGEX_DEFAULT_VALUES")

    patterns: dict[str, dict] = {}
    for entry in read["reads"]:
        where = [*entry["at"], *entry["writtenAt"]]
        if "id" in entry:
            for at in where:
                add(entry["id"], at, "readBy", entry["reader"])
            if not where:
                add(entry["id"], None, "readBy", entry["reader"])
        else:
            pattern = patterns.setdefault(entry["pattern"], {"source": set(), "readBy": set()})
            pattern["source"].update(where)
            pattern["readBy"].add(entry["reader"])
    for pattern, facts in patterns.items():
        start, _, end = pattern.partition("*")
        for identifier in list(ids):
            fits = (
                len(identifier) >= len(start) + len(end) and identifier.startswith(start) and identifier.endswith(end)
            )
            if fits and pattern != "*":
                for reader in facts["readBy"]:
                    add(identifier, None, "readBy", reader)
                add(identifier, None, "patterns", pattern)

    items = [
        item(
            f"ui-string:{name(identifier)}",
            sorted(facts.pop("source")),
            **{
                fact: sorted(values) if fact != "hqBuildVersions" else _ordered(values)
                for fact, values in facts.items()
            },
        )
        for identifier, facts in sorted(ids.items())
    ]
    for pattern, facts in sorted(patterns.items()):
        if pattern in ids:
            raise SurfaceError(f"The UI string pattern {pattern} is also an id a catalog holds.")
        items.append(
            item(f"ui-string:{name(pattern)}", sorted(facts["source"]), pattern=True, readBy=sorted(facts["readBy"]))
        )
    return items


def hq_catalogs(sources: Sources, directory: Path) -> tuple[dict[str, set[str]], dict[str, tuple[str, set[str]]]]:
    """The catalogs HQ's loader selects: each current catalog's ids, by its repository path, and each English
    historical catalog's (its path and ids), by the build version it is named for.

    The loader is HQ's own, run with ``open`` recorded; its inputs are every language the directory's catalog
    files name (with ``pt``, which HQ reads as ``por``), at catalog versions 1 and 2, with no build version,
    ``latest``, and each historical catalog's version."""
    import commcare_translations

    directory = directory.resolve()
    loader = Path(inspect.getsourcefile(commcare_translations)).resolve()
    if not (directory / loader.name).is_file():
        raise SurfaceError(f"HQ's CommCare catalog loader ({loader.name}) is not in {directory}.")
    languages = {"pt"}
    named_versions = set()
    for path in sorted(directory.iterdir()):
        if path.name.startswith("messages_") and path.suffix == ".txt":
            languages.add(path.stem.removeprefix("messages_").rpartition("-")[0])
    for path in sorted((directory / HISTORICAL).iterdir()):
        if "-messages_" in path.name and path.suffix == ".txt":
            named_versions.add(path.name.partition("-messages_")[0])
    if not languages - {"pt"} or not named_versions:
        raise SurfaceError(f"The surface extractor found no CommCare catalog files in {directory}.")

    selected: dict[Path, set[str]] = {}
    for language in sorted(languages):
        for version in (1, 2):
            for commcare_version in (None, "latest", *sorted(named_versions)):
                opened, messages = _load(commcare_translations, directory, language, version, commcare_version)
                if opened is not None:
                    selected[opened] = set(messages)
    if not selected:
        raise SurfaceError(f"HQ's CommCare catalog loader opened no catalog in {directory}.")
    current: dict[str, set[str]] = {}
    historical: dict[str, tuple[str, set[str]]] = {}
    for path, keys in selected.items():
        where = f"commcare-hq/{TRANSLATIONS}/{path.relative_to(directory).as_posix()}"
        if path.parent.name == HISTORICAL:
            historical[path.name.partition("-messages_")[0]] = (where, keys)
        else:
            current[where] = keys
    return current, historical


def _load(commcare_translations, directory: Path, language: str, version: int, commcare_version):
    """What ``load_translations`` returns for these inputs, and the catalog file it opened (in ``directory``)."""
    opened: list[Path] = []
    real_open = commcare_translations.open
    real_file = commcare_translations.__file__

    def recording(path, *arguments, **keywords):
        handle = real_open(path, *arguments, **keywords)
        # As the loader names it: ``messages_en-2.txt`` is a link to the newest historical catalog, and HQ
        # selects it by its own name.
        opened.append(Path(os.path.normpath(path)))
        return handle

    commcare_translations.open = recording
    # The loader finds its catalogs beside its own file; a planted copy of the directory stands in for it.
    commcare_translations.__file__ = str(directory / Path(real_file).name)
    try:
        messages = commcare_translations.load_translations(language, version=version, commcare_version=commcare_version)
    finally:
        commcare_translations.open = real_open
        commcare_translations.__file__ = real_file
    return (opened[-1] if opened else None), messages


def _version(text: str):
    from packaging.version import Version

    return Version(text)


def _runs(holds: list[bool], versions: list[str]) -> list[str]:
    """``<first>..<last>`` for each run of consecutive versions that hold the id (a lone version as itself)."""
    runs = []
    start = None
    for index, held in enumerate([*holds, False]):
        if held and start is None:
            start = index
        elif not held and start is not None:
            first, last = versions[start], versions[index - 1]
            runs.append(first if first == last else f"{first}..{last}")
            start = None
    return runs


def _ordered(runs: set[str]) -> list[str]:
    return sorted(runs, key=lambda run: _version(run.partition("..")[0]))
