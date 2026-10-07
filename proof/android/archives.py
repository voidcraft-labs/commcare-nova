"""The archives a device installs of one document, read from what a lane run observed.

The observation keeps, for every state HQ built, the archive HQ's download hands a device
(``proof.observe.build.archive_record``: each entry's bytes a blob, under the name HQ's own arrangement gives
it): A, B and B-edit in each state's record, and every app an editor save left whose build is not the one it was
saved over, in proof 4's record. Nova's own local archives are the document's files. ``document_archives`` names
them all:

- ``local.ccz``, ``local-again.ccz``, ``edit/local.ccz``: Nova's own exports;
- ``<configuration>/A``, ``<configuration>/B``, ``<configuration>/B-edit``: HQ's builds;
- ``<configuration>/<over>/<editor>``: HQ's build of what an editor save left, the editor named as proof 4 names
  it (``editor:app settings``, ``editor:case list:m0``, ``vellum:m0.f0#1``).

``materialize`` writes one as the ``.ccz`` a worker installs from a file, entries in name order with a fixed
timestamp, so the same archive is the same bytes on every run. ``restore_of`` is the restore HQ served for the
document's case database over A (``proof.observe.unit``, ``restoreA``), which the reader's device applies.

Standard library only: this reads a store, and runs nothing of HQ.
"""

from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass
from pathlib import Path

from proof.store import disk

LOCAL_ARCHIVES = ("local.ccz", "local-again.ccz", "edit/local.ccz")
STATES = (("a", "A"), ("b", "B"), ("b_edit", "B-edit"))
# A zip entry's timestamp: the earliest the format holds.
EPOCH = (1980, 1, 1, 0, 0, 0)


@dataclass(frozen=True)
class Archive:
    """One archive a device installs: its name among a document's, and its entries (a local archive's path, or
    each entry's blob in the store)."""

    name: str
    path: Path | None = None
    entries: dict | None = None

    @property
    def digest_input(self):
        return str(self.path) if self.path is not None else self.entries


class StoreIncomplete(LookupError):
    """A store delta names a record or a blob it does not hold."""


def _records(delta: disk.Delta, group: str) -> dict:
    """The document's part records by ``<configuration>/<part>`` (and ``local``), from the delta."""
    for entry in delta.entries("documents").values():
        if entry.get("group") == group:
            found = {}
            for name, (_, record_digest) in entry["parts"].items():
                content = delta.blob(record_digest)
                if content is None:
                    raise StoreIncomplete(
                        f"The store names the record {record_digest} for {group}'s {name}, and holds no such blob."
                    )
                found[name] = json.loads(content)
            return found
    raise StoreIncomplete(
        f"The store holds no document entry for {group}. Name a run's own store (its output's store/), from a"
        " run that observed the document."
    )


def _editor_label(view, section):
    scope = view["scope"]
    place = "" if scope[0] is None else f":m{scope[0]}" + ("" if scope[1] is None else f".f{scope[1]}")
    return f"editor:{section['section']}{place}"


def saved_archives(proof4: dict) -> dict:
    """Each editor save's archive in a proof 4 record, by the editor's name; only where the save's build is not
    the build it was saved over (elsewhere the record holds none, and a device installs what it did before)."""
    found = {}
    for view in proof4.get("views", ()):
        for section in view.get("sections", ()):
            archive = section.get("archive")
            if archive and archive.get("entries"):
                found[_editor_label(view, section)] = archive["entries"]
    for form in proof4.get("vellum", ()):
        m, f = form["scope"]
        for ordinal, run in enumerate(form.get("runs", ()), start=1):
            archive = run.get("archive")
            if archive and archive.get("entries"):
                found[f"vellum:m{m}.f{f}#{ordinal}"] = archive["entries"]
    return found


def document_archives(store: Path, document_id: str, root: Path | None = None, kind: str = "corpus") -> list[Archive]:
    """Every archive a device installs of the document, in a fixed order. ``root`` is the document's directory
    (for Nova's local archives); ``store`` a lane run's store delta."""
    delta = disk.Delta(Path(store))
    records = _records(delta, f"{kind}:{document_id}")
    found = []
    if root is not None:
        for name in LOCAL_ARCHIVES:
            if (Path(root) / name).is_file():
                found.append(Archive(name, path=Path(root) / name))
    for name in sorted(records):
        if "/" not in name:
            continue
        configuration, part = name.split("/", 1)
        record = records[name]
        if "same_as" in record:
            continue
        for part_name, state in STATES:
            if part != part_name:
                continue
            archive = (record.get("state") or {}).get("archive")
            if archive and archive.get("entries"):
                found.append(Archive(f"{configuration}/{state}", entries=archive["entries"]))
            for editor, entries in sorted(saved_archives(record.get("proof4") or {}).items()):
                found.append(Archive(f"{configuration}/{state}/{editor}", entries=entries))
    return found


def restore_of(store: Path, document_id: str, configuration: str, kind: str = "corpus") -> bytes | None:
    """The restore HQ served over A for the document's case database under ``configuration``; None where HQ
    served none."""
    delta = disk.Delta(Path(store))
    record = _records(delta, f"{kind}:{document_id}").get(f"{configuration}/a") or {}
    digest = (record.get("restoreA") or {}).get("restore")
    if digest is None:
        return None
    content = delta.blob(digest)
    if content is None:
        raise StoreIncomplete(f"The store names the restore {digest} for {document_id}, and holds no such blob.")
    return content


def materialize(store: Path, archive: Archive, target: Path) -> Path:
    """The archive as the ``.ccz`` file a worker installs, at ``target``. A local archive is copied as it is."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if archive.path is not None:
        target.write_bytes(archive.path.read_bytes())
        return target
    delta = disk.Delta(Path(store))
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zipped:
        for name in sorted(archive.entries):
            content = delta.blob(archive.entries[name])
            if content is None:
                raise StoreIncomplete(
                    f"The store names the blob {archive.entries[name]} for {archive.name}'s {name}, and holds none."
                )
            zipped.writestr(zipfile.ZipInfo(name, EPOCH), content, zipfile.ZIP_DEFLATED)
    return target
