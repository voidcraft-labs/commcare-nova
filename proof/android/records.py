"""What the Android stage asks the reader of one document, and the key each answer is kept under.

A document's records (``proof.observe``) keep every archive a device installs of it: Nova's own local exports
are files of its directory, and each state HQ built keeps HQ's download arrangement with its multimedia
(``state.archive``; each editor save's in proof 4's record), with the restore that state's sessions read
(``restoreA``, ``sessions.restoreLocal``, ``proof4.restore``). ``plan`` turns them into the reader's requests
(``proof/android/README.md`` names what each answers):

- ``app`` for each archive a judge reads: Nova's ``local.ccz``; A, B and B-edit of each configuration; and each
  editor save's;
- ``installs`` for each pair that is two installs of one app: the two local exports, and A then B;
- ``update`` for each device that moves from one archive to the next: ``local.ccz`` to ``local-again.ccz`` and
  A to B, each with every form left incomplete before it and a worker's own settings; and B (or B-edit) to
  each editor save whose profile is not the one it was saved over, with a worker's own settings.

An answer is a function of the request's archives and restore, the request's options, and the reader
(``fingerprint``): commcare-android and commcare-core at their pins, the reader's own code, the answer table
and the toolchain the runtime is built with. ``Request.key`` names exactly those, so an archive read before is
never read again, whichever document or state it is an archive of (``proof.store.keys``: an ``android`` entry
of the evidence store holds the answer's blob).

Standard library only.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from proof.store import disk, keys

PROOF_DIR = Path(__file__).resolve().parents[1]
ANDROID_DIR = Path(__file__).resolve().parent
ANSWERS = PROOF_DIR / "core" / "answers.json"
PINS = PROOF_DIR / "pins.json"
TOOLCHAIN = ANDROID_DIR / "toolchain.json"
# The reader's files: its Java, its client, what builds its runtime and what plans its requests. A change to
# any of them reads every archive again.
READER_FILES = ("client.py", "records.py", "build-runtime.sh", "reader.init.gradle", "toolchain.json")
READER_DIRECTORIES = ("src",)
PINNED = ("commcare-android", "commcare-core")
VERSION = 1
LOCAL = "local.ccz"
LOCAL_AGAIN = "local-again.ccz"
STATES = (("a", "A"), ("b", "B"), ("b_edit", "B-edit"))
# A worker's own settings, written before an update: the two a worker sets on Android's settings screen that
# HQ's profile can force (MainConfigurablePreferences, R.xml.main_preferences; ``profile.settings`` in an
# answer names every recorded setting that screen declares).
WORKER_SETTINGS = {"cc-enable-tts": "yes", "cc-autoup-freq": "freq-daily"}
PROFILE = "profile.ccpr"
# A zip entry's timestamp: the earliest the format holds.
EPOCH = (1980, 1, 1, 0, 0, 0)


class RecordsIncomplete(LookupError):
    """The stores name a record or a blob of a document and hold none."""


# The reader's fingerprint -------------------------------------------------------------------------------------


def _blob_hash(content: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(content) + content).hexdigest()


def reader_files(root: Path = ANDROID_DIR) -> dict[str, str]:
    """Every file of the reader by its path under ``proof/android``, with the hash git gives its bytes."""
    found = {}
    for name in READER_FILES:
        found[name] = _blob_hash((root / name).read_bytes())
    for directory in READER_DIRECTORIES:
        for path in sorted((root / directory).rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                found[path.relative_to(root).as_posix()] = _blob_hash(path.read_bytes())
    return found


def fingerprint(platform: str, *, root: Path = ANDROID_DIR, pins: Path = PINS, answers: Path = ANSWERS) -> str:
    """What names the reader an answer was read by: its files, the pins it runs, the answer table and where it
    runs (``linux-amd64``, ``darwin-arm64``: Robolectric's native runtime is the platform's own)."""
    pinned = json.loads(Path(pins).read_text(encoding="utf-8"))
    return keys.hashed(
        "android-reader",
        VERSION,
        dict(sorted(reader_files(root).items())),
        {name: pinned[name]["commit"] for name in PINNED},
        _blob_hash(Path(answers).read_bytes()),
        platform,
    )


def host_platform() -> str:
    import platform

    system = {"Linux": "linux", "Darwin": "darwin"}.get(platform.system(), platform.system().lower())
    machine = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}.get(
        platform.machine().lower(), platform.machine().lower()
    )
    return f"{system}-{machine}"


# The records a document's archives are read from --------------------------------------------------------------


class Source:
    """Where a document's records and their blobs are: the deltas lane runs wrote beside their outputs, and a
    snapshot of the evidence store for a document whose records no run of this lane observed."""

    def __init__(self, outputs=(), snapshot: Path | None = None):
        self.deltas = [disk.Delta(Path(output) / disk.DELTA) for output in outputs]
        self.deltas = [delta for delta in self.deltas if delta.root.is_dir()]
        self.snapshot = disk.Snapshot(snapshot) if snapshot is not None and Path(snapshot).is_dir() else None
        self._documents: dict[str, dict] | None = None

    def blob(self, digest: str) -> bytes:
        for holder in (*self.deltas, *([self.snapshot] if self.snapshot else [])):
            content = holder.blob(digest)
            if content is not None:
                return content
        raise RecordsIncomplete(f"No store given holds the blob {digest}.")

    def _entries(self) -> dict[str, dict]:
        if self._documents is None:
            found = {}
            if self.snapshot is not None:
                found.update(self.snapshot.index["documents"])
            for delta in self.deltas:
                found.update(delta.entries("documents"))
            self._documents = found
        return self._documents

    def parts(self, group: str, key: str | None = None) -> dict:
        """The document's part records by ``<configuration>/<part>`` (and ``local``): under ``key`` (its document
        key, ``proof.store.keys.document_key``) where one is named, else the one entry the stores hold for
        ``group``."""
        entries = self._entries()
        if key is not None:
            entry = entries.get(key)
            if entry is None or entry["group"] != group:
                raise RecordsIncomplete(
                    f"No store given holds {group}'s records under its document key {key[:16]}: the lane that"
                    " queued it neither observed it nor read it from a store given here."
                )
        else:
            held = [entry for entry in entries.values() if entry["group"] == group]
            if len(held) != 1:
                raise RecordsIncomplete(
                    f"The stores given hold {len(held)} document entries for {group}; name its document key, or"
                    " give the output of one run that observed it."
                )
            entry = held[0]
        return {name: json.loads(self.blob(digest)) for name, (_, digest) in entry["parts"].items()}


# Archives -----------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Archive:
    """One archive a device installs: a local export's file, or each entry's blob in the stores."""

    name: str
    path: Path | None = None
    entries: tuple | None = None

    def contents(self, source: Source) -> dict[str, bytes]:
        if self.path is not None:
            with zipfile.ZipFile(self.path) as zipped:
                return {info.filename: zipped.read(info) for info in zipped.infolist() if not info.is_dir()}
        return {name: source.blob(digest) for name, digest in self.entries}

    def digests(self, source: Source) -> dict[str, str]:
        """Each entry's name with the digest of its bytes: what an archive is, whatever file holds it."""
        if self.path is not None:
            return {name: disk.digest_of(content) for name, content in self.contents(source).items()}
        return dict(self.entries)

    def digest(self, source: Source) -> str:
        return keys.hashed("android-archive", VERSION, dict(sorted(self.digests(source).items())))

    def write(self, source: Source, target: Path) -> Path:
        """The archive as the ``.ccz`` file a worker installs: entries in name order with a fixed timestamp,
        whichever file or store they come from, so one archive is one file's bytes."""
        target.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zipped:
            for name, content in sorted(self.contents(source).items()):
                zipped.writestr(zipfile.ZipInfo(name, EPOCH), content, zipfile.ZIP_DEFLATED)
        return target


def _stored(name: str, archive, build=None) -> Archive | None:
    """The archive a record keeps for a state, or None: where it keeps none, or where HQ releases no build of
    the state (``build``, its recorded outcome), since no worker is ever handed that archive."""
    if not archive or not archive.get("entries") or not released(build):
        return None
    return Archive(name, entries=tuple(sorted(archive["entries"].items())))


def released(build) -> bool:
    """Whether HQ makes a release of a state from its recorded build (``proof.observe.runs.unbuildable``, read
    from the record: HQ's validation listed no error and raised nothing, and HQ wrote the build's files). A
    record that keeps no build beside an archive (None) is one of a state the archive itself stands for."""
    if build is None:
        return True
    return (
        build.get("files") is not None and "validate_app" not in (build.get("raised") or {}) and not build.get("errors")
    )


def _editor(view, section) -> str:
    scope = view["scope"]
    place = "" if scope[0] is None else f":m{scope[0]}" + ("" if scope[1] is None else f".f{scope[1]}")
    return f"{section['section']}{place}"


def saves(proof4: dict) -> list[tuple[str, str, str | None, Archive | None]]:
    """Each editor save of a proof 4 record as ``(label, editor, over, archive)``: ``editor`` as proof 4 names
    the save's editor (a page's section, ``vellum``, ``vellum again``), ``over`` the label of the save it was
    made over (None: the B the record is of), and the archive of what it left, None where its build is the
    build it was saved over (the record then keeps none, and a device installs what it did before)."""
    found = []
    for view in proof4.get("views", ()):
        for section in view.get("sections", ()):
            if "archive" in section or "build" in section:
                label = _editor(view, section)
                archive = _stored(label, section.get("archive"), section.get("build"))
                found.append((label, section["section"], None, archive))
    for form in proof4.get("vellum", ()):
        m, f = form["scope"]
        over = None
        for editor, run in zip(("vellum", "vellum again"), form.get("runs", ()), strict=False):
            if "archive" not in run and "build" not in run:
                continue
            label = f"{editor}:m{m}.f{f}"
            archive = _stored(label, run.get("archive"), run.get("build"))
            found.append((label, editor, over, archive))
            if archive is not None:
                over = label
    return found


# Requests -----------------------------------------------------------------------------------------------------


@dataclass
class Request:
    """One request of the reader: its name among the document's, the reader's ``op``, the archives and restore
    it reads and its other options."""

    name: str
    op: str
    archives: dict[str, Archive]
    restore: str | None = None
    options: dict = field(default_factory=dict)

    def summary(self, source: Source) -> dict:
        """What the request reads, as its key names it."""
        options = dict(self.options)
        if "answers" in options:
            # The answer table by its digest: the key names every value of it, and a record need not hold it.
            options["answers"] = keys.hashed("android-answers", VERSION, options["answers"])
        return {
            "op": self.op,
            "archives": {role: archive.digest(source) for role, archive in sorted(self.archives.items())},
            "restore": self.restore,
            "options": options,
        }

    def key(self, source: Source, reader: str) -> str:
        return keys.hashed("android-record", VERSION, reader, self.summary(source))


# What every search screen's free-text prompts are also answered with, on a screen of its own: an answer that
# holds both quote marks, which no XPath string literal can hold (finding 48). The answer records what the
# screen then sends and what it shows when the server refuses the query.
QUERY_ANSWER = 'it\'s "x"'


def _app(name, archive, restore, answers) -> Request:
    return Request(
        f"app@{name}", "app", {"archive": archive}, restore, {"answers": answers, "queryAnswer": QUERY_ANSWER}
    )


def _installs(name, first, second) -> Request:
    return Request(f"installs@{name}", "installs", {"first": first, "second": second})


def _update(name, before, after, restore, *, incomplete) -> Request:
    options = {"preferences": dict(WORKER_SETTINGS)}
    if incomplete:
        options["incompleteForms"] = True
    return Request(f"update@{name}", "update", {"archive": before, "update": after}, restore, options)


def plan(parts: dict, root: Path | None, source: Source, *, answers: dict | None = None) -> list[Request]:
    """Every request the stage makes of the reader for one document: ``parts`` its record parts, ``root`` its
    directory (for Nova's local archives)."""
    answers = json.loads(ANSWERS.read_text(encoding="utf-8")) if answers is None else answers
    found = []
    configurations = sorted({name.split("/", 1)[0] for name in parts if "/" in name})
    local = again = None
    if root is not None:
        if (Path(root) / LOCAL).is_file():
            local = Archive(LOCAL, path=Path(root) / LOCAL)
        if (Path(root) / LOCAL_AGAIN).is_file():
            again = Archive(LOCAL_AGAIN, path=Path(root) / LOCAL_AGAIN)
    # The restore the local archive's sessions read (cases, and no table: the archive carries its own), which
    # every configuration records alike; a document HQ built no A of records none, and its local archive is
    # read without one.
    local_restore = next(
        (
            restore
            for name in configurations
            if (restore := ((parts.get(f"{name}/b_aligned") or {}).get("sessions") or {}).get("restoreLocal"))
        ),
        None,
    )
    for configuration in configurations:
        a_record = parts.get(f"{configuration}/a") or {}
        restore_a = (a_record.get("restoreA") or {}).get("restore")
        state_a = a_record.get("state") or {}
        a = _stored(f"{configuration}/A", state_a.get("archive"), state_a.get("build"))
        if a is not None:
            found.append(_app(a.name, a, restore_a, answers))
        for part, state in STATES[1:]:
            record = parts.get(f"{configuration}/{part}") or {}
            if "same_as" in record:
                continue
            held_state = record.get("state") or {}
            archive = _stored(f"{configuration}/{state}", held_state.get("archive"), held_state.get("build"))
            if archive is None:
                continue
            proof4 = record.get("proof4") or {}
            restore = proof4.get("restore") or restore_a
            found.append(_app(archive.name, archive, restore, answers))
            if state == "B" and a is not None:
                found.append(_installs(f"{configuration}/A", a, archive))
                found.append(_update(f"{configuration}/A", a, archive, restore_a, incomplete=True))
            held = {None: archive}
            for label, _, over, saved in saves(proof4):
                if saved is None:
                    continue
                named = Archive(f"{archive.name}/{label}", entries=saved.entries)
                held[label] = named
                found.append(_app(named.name, named, restore, answers))
                base = held.get(over, archive)
                if dict(named.entries).get(PROFILE) != dict(base.entries).get(PROFILE):
                    found.append(_update(named.name, base, named, restore, incomplete=False))
    # Nova's local archives are read where HQ released some build of A to read them against: with none, proof 3
    # and proof 1's local path have no baseline, and the lane's own checks report why HQ released none.
    if local is not None and any(request.name.endswith("/A") and request.op == "app" for request in found):
        ahead = [_app(LOCAL, local, local_restore, answers)]
        if again is not None:
            ahead.append(_installs(LOCAL, local, again))
            ahead.append(_update(LOCAL, local, again, local_restore, incomplete=True))
        found = ahead + found
    return found


def run(reader, request: Request, source: Source, scratch: Path) -> dict:
    """The reader's answer to one request, as the stage keeps it: ``{"request": <summary>, "answer": ...}``, or
    ``{"request": ..., "readerFailed": <why>, "log": <the end of the JVM's output>}`` where the reader itself
    could not answer (never what Android answered: an install Android refuses is an answer)."""
    from proof.android.client import AndroidReaderError

    # A directory of the request's own, written once: a file the reader was handed is never written again while
    # a device may be reading it (the stage answers each key once, ``proof.android.stage.Run._answer``).
    scratch.mkdir(parents=True, exist_ok=False)
    arguments = dict(request.options)
    written = {}
    for role, archive in sorted(request.archives.items()):
        digest = archive.digest(source)
        if digest not in written:
            written[digest] = archive.write(source, scratch / f"{digest[:24]}.ccz")
        arguments[role] = str(written[digest])
    if request.op == "installs":
        arguments = {"archives": [arguments["first"], arguments["second"]]}
    if request.restore is not None:
        restore = scratch / f"restore-{request.restore.removeprefix(disk.PREFIX)[:24]}" / "restore.xml"
        restore.parent.mkdir(parents=True, exist_ok=True)
        restore.write_bytes(source.blob(request.restore))
        arguments["restore"] = str(restore)
    record = {"request": request.summary(source)}
    try:
        record["answer"] = reader.request(request.op, **arguments)
    except AndroidReaderError as error:
        record["readerFailed"] = str(error)
        record["log"] = error.log[-8000:]
    return record
