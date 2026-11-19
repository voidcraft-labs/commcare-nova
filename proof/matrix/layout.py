"""The one reader of a retained tree: what a run or an artifact wrote, read as data and never as files of the host's.

A run's output is written by a container that runs upstream code, and an
artifact by another job, so nothing under either is trusted to be what its
name says. ``read_tree`` is the only code that turns such a directory into
retained members, and every consumer goes through it: adoption
(``proof.matrix.adopt``), placement between a checkout and an artifact
(``proof.matrix.place``), a base's reading input (``proof.matrix.lane_input``)
and the test that holds the committed trees to it (``test_layout.py``).

The layout is ``proof/matrix/retained-layout.json``:

- ``hq-apps/<base>/``: ``<base>`` an id ``proof/matrix/bases.json`` lists;
  its files the JSON files the layout names, ``fixture-rows-<tag>.json``, and
  ``media/<n>.<ext>`` with a decimal ``<n>`` and an extension a stand-in has
  (``proof/matrix/stand-ins.json``); each ``media.json`` row names one of the
  base's own media files.
- ``hq-reads/<group>/<name>.json``: one level, the group lowercase words
  joined by hyphens, the name letters and digits joined by hyphens.

Beside a block's trees a run writes its held records
(``retained-held/<tree>/<directory>/<test>.json``, ``proof.matrix.retained``):
for each directory a test's comparisons held, one record a comparing test, the
committed files of its own it did not make, which adoption removes.
``read_held`` reads them under the same rules: each record under a directory
the tree may hold, named as ``retained.record_name`` names one, an object
whose one key ``extra`` lists paths each a file that directory may hold, so a
record can name nothing outside the tree it is for.

A run writes each retained file and each record beside its name first and
renames it over its name once whole (``retained.write_whole``), so a run
stopped mid-write can leave ``.<name>.<pid>.partial`` beside a member or a
record. Such a plain file, whose ``<name>`` is one the layout admits there, is
none the run made: it is passed over unread, never refused and never adopted.

Every name is checked before a byte is read, and each refusal is named: a
hidden name, any other name or suffix, a deeper path, a link, anything but a
directory or a regular file, a member over its bound, a tree over its bound,
and a ``.json`` member that is not strict UTF-8 JSON with an object or an
array at its top. Each component is opened relative to the one above it
without following a link (``O_NOFOLLOW``), so a link anywhere below the
directory the caller names is refused rather than read through, and a file
is opened non-blocking, so a pipe cannot hold the reader. A file's link
count is not read: ``link(2)`` never crosses a mount, so a container cannot
make a second name for a host file under the output it was given.

Standard library only, on Python 3.12: it runs on a hosted runner's own
``python3`` with no image.
"""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

MATRIX = Path(__file__).resolve().parent
LAYOUT_FILE = MATRIX / "retained-layout.json"
BASES_FILE = MATRIX / "bases.json"
STAND_INS_FILE = MATRIX / "stand-ins.json"
TREES = ("hq-apps", "hq-reads")
# A retained tree is two levels deep (``hq-apps/<base>/media/<n>.<ext>`` is the deepest member); a walk names a
# deeper entry and goes no further.
DEPTH = 3
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
# The fix every refusal of a name ends with.
NAME_IT = (
    "A base holds the JSON files proof/matrix/retain.py names, its fixture rows and its media files, and a group of"
    " proof/hq-reads/ holds JSON answers. If the lane now retains a new file, name it in"
    " proof/matrix/retained-layout.json in the same change."
)


# A file ``retained.write_whole`` writes beside its name before the rename: ``.<name>.<pid>.partial``.
PARTIAL = re.compile(r"\.(?P<name>[^.].*)\.(?:0|[1-9][0-9]{0,9})\.partial")


class LayoutRefused(ValueError):
    """What was read is not a retained tree; ``refusals`` names each entry outside the layout."""

    def __init__(self, refusals: list[str]):
        self.refusals = refusals
        shown = refusals[:20]
        more = f" ({len(refusals) - len(shown)} more)" if len(refusals) > len(shown) else ""
        super().__init__(
            "Nothing was adopted or placed, because what was read is not a retained tree:\n"
            + "\n".join(f"- {line}" for line in shown)
            + more
        )


@dataclass(frozen=True)
class Layout:
    bases: frozenset[str]
    base_files: frozenset[str]
    base_patterns: tuple[re.Pattern, ...]
    media_directory: str
    media_name: re.Pattern
    group: re.Pattern
    group_patterns: tuple[re.Pattern, ...]
    artifact: tuple[str, ...]
    held: str
    held_record: re.Pattern
    json_bound: int
    media_bound: int
    tree_bound: int
    report_bound: int

    def media_file(self, name: str) -> bool:
        """Whether ``name`` is a media member's path under its base (``media/<n>.<ext>``)."""
        return self.media_name.fullmatch(name) is not None

    def member(self, tree: str, parts: tuple[str, ...]) -> bool:
        """Whether a directory of ``tree`` may hold a file at ``parts`` (its path under the directory)."""
        if tree == "hq-reads":
            return len(parts) == 1 and any(pattern.fullmatch(parts[0]) for pattern in self.group_patterns)
        if len(parts) == 1:
            return parts[0] in self.base_files or any(pattern.fullmatch(parts[0]) for pattern in self.base_patterns)
        return self.media_file("/".join(parts))

    def directory(self, tree: str, name: str) -> bool:
        """Whether ``tree`` may hold a directory named ``name`` at its top."""
        return name in self.bases if tree == "hq-apps" else self.group.fullmatch(name) is not None

    def bound(self, name: str) -> int:
        return self.json_bound if name.endswith(".json") else self.media_bound

    def record(self, name: str) -> bool:
        """Whether ``name`` is a held record's file name (``retained.record_name``)."""
        return self.held_record.fullmatch(name) is not None


def load(layout_file: Path = LAYOUT_FILE, bases_file: Path = BASES_FILE, stand_ins: Path = STAND_INS_FILE) -> Layout:
    """The layout the checkout states: its file, the base ids and the stand-ins' extensions."""
    declared = json.loads(layout_file.read_text(encoding="utf-8"))
    apps, reads = declared["trees"]["hq-apps"], declared["trees"]["hq-reads"]
    extensions = sorted({row["extension"] for row in json.loads(stand_ins.read_text(encoding="utf-8"))})
    if not extensions or not all(re.fullmatch(r"[a-z0-9]+", extension) for extension in extensions):
        raise ValueError(f"{stand_ins} gives no stand-in extension, or one that is not lowercase letters and digits.")
    media = apps["media"]
    alternatives = "|".join(re.escape(extension) for extension in extensions)
    bounds = declared["bounds"]
    return Layout(
        bases=frozenset(json.loads(bases_file.read_text(encoding="utf-8"))),
        base_files=frozenset(apps["files"]),
        base_patterns=tuple(re.compile(pattern) for pattern in apps["patterns"]),
        media_directory=media["directory"],
        media_name=re.compile(f"{re.escape(media['directory'])}/{media['name']}\\.(?:{alternatives})"),
        group=re.compile(reads["directory"]),
        group_patterns=tuple(re.compile(pattern) for pattern in reads["patterns"]),
        artifact=tuple(declared["artifact"]),
        held=declared["held"]["directory"],
        held_record=re.compile(declared["held"]["name"]),
        json_bound=int(bounds["json"]),
        media_bound=int(bounds["media"]),
        tree_bound=int(bounds["tree"]),
        report_bound=int(bounds["report"]),
    )


def kind_of(mode: int) -> str:
    if stat.S_ISLNK(mode):
        return "a link"
    if stat.S_ISFIFO(mode):
        return "a pipe"
    if stat.S_ISSOCK(mode):
        return "a socket"
    if stat.S_ISCHR(mode) or stat.S_ISBLK(mode):
        return "a device"
    return "not a regular file"


def open_directory(anchor: Path, *parts: str) -> int | None:
    """A descriptor of ``anchor/parts...``: ``anchor`` as the caller names it (it may be a link, as ``.proof/out``
    is), each part below it opened without following a link. None where it or a part does not exist;
    ``LayoutRefused`` where a part is a link or not a directory."""
    try:
        fd = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    walked = Path(anchor)
    try:
        for part in parts:
            walked = walked / part
            try:
                mode = os.stat(part, dir_fd=fd, follow_symlinks=False).st_mode
            except FileNotFoundError:
                os.close(fd)
                return None
            if not stat.S_ISDIR(mode):
                raise LayoutRefused(
                    [f"{walked} is {kind_of(mode)}, and a run or an artifact writes directories there."]
                )
            inner = os.open(part, DIRECTORY_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = inner
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    return fd


def _entries(fd: int) -> list[tuple[str, int]]:
    """Each entry of the directory ``fd``, by name, with its mode as it is (a link as a link), in name order."""
    found = []
    with os.scandir(fd) as entries:
        for entry in entries:
            found.append((entry.name, entry.stat(follow_symlinks=False).st_mode))
    return sorted(found)


def _walk(
    fd: int, shown: Path, depth: int, refusals: list[str], partials: list[tuple[str, ...]] | None = None
) -> list[tuple[str, ...]]:
    """The path of each regular file under ``fd`` (relative to it), naming every other entry in ``refusals``. A
    plain file named as ``retained.write_whole``'s unrenamed write is no member: the path it was written for goes in
    ``partials``, for the caller to hold to the layout, and the file is not read."""
    files = []
    partials = [] if partials is None else partials
    for name, mode in _entries(fd):
        path = shown / name
        partial = PARTIAL.fullmatch(name)
        if partial is not None and stat.S_ISREG(mode):
            partials.append((partial["name"],))
            continue
        if name.startswith("."):
            refusals.append(f"{path} is a hidden name, and a retained tree holds none. {NAME_IT}")
            continue
        if stat.S_ISDIR(mode):
            if depth <= 1:
                refusals.append(f"{path} is a directory deeper than a retained tree goes. {NAME_IT}")
                continue
            inner = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
            nested: list[tuple[str, ...]] = []
            try:
                files += [(name, *rest) for rest in _walk(inner, path, depth - 1, refusals, nested)]
            finally:
                os.close(inner)
            partials += [(name, *rest) for rest in nested]
        elif stat.S_ISREG(mode):
            files.append((name,))
        else:
            refusals.append(f"{path} is {kind_of(mode)}, and a retained tree holds only directories and plain files.")
    return files


def read_bounded(fd: int, name: str, bound: int, shown: Path) -> bytes:
    """The bytes of the regular file ``name`` under the directory ``fd``, opened without following a link and
    without blocking; ``LayoutRefused`` where it is anything else or holds more than ``bound`` bytes."""
    try:
        member = os.open(name, FILE_FLAGS, dir_fd=fd)
    except OSError as error:
        raise LayoutRefused([f"{shown} could not be opened as a plain file ({error.strerror})."]) from error
    try:
        mode = os.fstat(member).st_mode
        if not stat.S_ISREG(mode):
            raise LayoutRefused([f"{shown} is {kind_of(mode)}, and a retained tree holds only plain files."])
        chunks = []
        held = 0
        while True:
            chunk = os.read(member, min(1 << 20, bound + 1 - held))
            if not chunk:
                break
            chunks.append(chunk)
            held += len(chunk)
            if held > bound:
                raise LayoutRefused([f"{shown} holds more than {bound} bytes, its bound in a retained tree."])
        return b"".join(chunks)
    finally:
        os.close(member)


def json_refusal(data: bytes) -> str | None:
    """Why ``data`` is not strict UTF-8 JSON with an object or an array at its top, or None where it is."""

    def constant(name):
        raise ValueError(f"{name} is no JSON value")

    try:
        value = json.loads(data.decode("utf-8"), parse_constant=constant)
    except (UnicodeDecodeError, ValueError) as error:
        return f"is not strict UTF-8 JSON ({error})"
    if not isinstance(value, (dict, list)):
        return "holds neither an object nor an array at its top"
    return None


def _media_rows_refusal(directory: str, members: dict[str, bytes], layout: Layout) -> list[str]:
    """Each ``media.json`` row of a base that names no media file of the same base."""
    if "media.json" not in members:
        return []
    rows = json.loads(members["media.json"].decode("utf-8"))
    refusals = []
    if not isinstance(rows, list):
        return [f"hq-apps/{directory}/media.json holds no list of rows."]
    for index, row in enumerate(rows):
        named = row.get("file") if isinstance(row, dict) else None
        if not isinstance(named, str) or not layout.media_file(named) or named not in members:
            refusals.append(
                f"hq-apps/{directory}/media.json's row {index} names {json.dumps(named)}, which is not one of the"
                " base's media files."
            )
    return refusals


def _plan(fd: int, shown: Path, tree: str, name: str, layout: Layout, refusals: list[str]) -> list[tuple[str, ...]]:
    """The member paths of the directory ``name`` of a tree (the tree's descriptor ``fd``), each entry outside the
    layout named in ``refusals``."""
    path = shown / name
    inner = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
    partials: list[tuple[str, ...]] = []
    try:
        files = _walk(inner, path, DEPTH - 1, refusals, partials)
    finally:
        os.close(inner)
    for parts in files:
        if not layout.member(tree, parts):
            refusals.append(f"{path / Path(*parts)} is not a file a retained tree holds. {NAME_IT}")
    for parts in partials:
        if not layout.member(tree, parts):
            refusals.append(
                f"{path / Path(*parts[:-1])} holds an unfinished write of {parts[-1]}, which is not a file a retained"
                f" tree holds. {NAME_IT}"
            )
    return files


def _read_planned(
    fd: int, shown: Path, tree: str, planned: dict[str, list[tuple[str, ...]]], layout: Layout
) -> dict[str, dict[str, bytes]]:
    """The bytes of every planned member, each through a descriptor walked down from the tree's ``fd`` without
    following a link; ``LayoutRefused`` for a member over its bound, the tree over its bound, a ``.json`` member that
    is not strict JSON and a ``media.json`` row naming no media file of its base."""
    refusals: list[str] = []
    found: dict[str, dict[str, bytes]] = {}
    total = 0
    for name, files in sorted(planned.items()):
        members = found.setdefault(name, {})
        for parts in files:
            member_shown = shown / name / Path(*parts)
            directory_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
            try:
                for part in parts[:-1]:
                    inner = os.open(part, DIRECTORY_FLAGS, dir_fd=directory_fd)
                    os.close(directory_fd)
                    directory_fd = inner
                data = read_bounded(directory_fd, parts[-1], layout.bound(parts[-1]), member_shown)
            finally:
                os.close(directory_fd)
            total += len(data)
            if total > layout.tree_bound:
                raise LayoutRefused([f"{shown} holds more than {layout.tree_bound} bytes, a retained tree's bound."])
            if parts[-1].endswith(".json"):
                why = json_refusal(data)
                if why is not None:
                    refusals.append(f"{member_shown} {why}.")
                    continue
            members["/".join(parts)] = data
    if tree == "hq-apps":
        for name, members in sorted(found.items()):
            refusals += _media_rows_refusal(name, members, layout)
    if refusals:
        raise LayoutRefused(refusals)
    return found


def read_tree(anchor: Path, *inside: str, tree: str, layout: Layout | None = None) -> dict[str, dict[str, bytes]]:
    """Every member of the retained tree ``tree`` at ``anchor/inside.../`` (the tree's own directory), by its base
    or group and its path there; ``{}`` where the directory does not exist. Raises ``LayoutRefused`` naming every
    entry outside the layout before any byte is read, and then any member over its bound or not strict JSON."""
    if tree not in TREES:
        raise ValueError(f"{tree} is no retained tree; the trees are {', '.join(TREES)}.")
    layout = layout or load()
    shown = Path(anchor, *inside)
    fd = open_directory(Path(anchor), *inside)
    if fd is None:
        return {}
    try:
        refusals: list[str] = []
        planned: dict[str, list[tuple[str, ...]]] = {}
        for name, mode in _entries(fd):
            path = shown / name
            if not stat.S_ISDIR(mode):
                what = "a file at the top of the tree" if stat.S_ISREG(mode) else kind_of(mode)
                refusals.append(f"{path} is {what}; every member sits in a base or a group. {NAME_IT}")
            elif not layout.directory(tree, name):
                why = "no base proof/matrix/bases.json lists" if tree == "hq-apps" else "no group name"
                refusals.append(f"{path} is {why}. {NAME_IT}")
            else:
                planned[name] = _plan(fd, shown, tree, name, layout, refusals)
        if refusals:
            raise LayoutRefused(refusals)
        return _read_planned(fd, shown, tree, planned, layout)
    finally:
        os.close(fd)


def read_held(anchor: Path, *inside: str, tree: str, layout: Layout | None = None) -> dict[str, frozenset[str]]:
    """Every held record at ``anchor/inside.../`` (a block's ``retained-held/<tree>/``): by the directory each is
    for, the union of the paths its records list; ``{}`` where the directory does not exist. Raises
    ``LayoutRefused`` naming every entry that is not a record of a directory ``tree`` may hold before any byte is
    read (each sits at ``<directory>/<test>.json``; an unrenamed write of one is passed over unread), and then every
    record that is not an object whose one key ``extra`` lists files that directory may hold."""
    if tree not in TREES:
        raise ValueError(f"{tree} is no retained tree; the trees are {', '.join(TREES)}.")
    layout = layout or load()
    shown = Path(anchor, *inside)
    fd = open_directory(Path(anchor), *inside)
    if fd is None:
        return {}
    where = (
        f"each sits at {layout.held}/{tree}/<directory>/<test>.json (proof/matrix/retained.py::Retained.held_record)"
    )
    try:
        refusals: list[str] = []
        planned: list[tuple[str, str]] = []
        for directory, mode in _entries(fd):
            path = shown / directory
            if directory.startswith("."):
                refusals.append(f"{path} is a hidden name, and the held records hold none.")
            elif stat.S_ISREG(mode):
                refusals.append(f"{path} is no held record: {where}.")
            elif not stat.S_ISDIR(mode):
                refusals.append(f"{path} is {kind_of(mode)}, and the held records of a directory sit in a directory.")
            elif not layout.directory(tree, directory):
                refusals.append(f"{path} holds the records of no directory {tree}/ may hold. {NAME_IT}")
            else:
                inner = os.open(directory, DIRECTORY_FLAGS, dir_fd=fd)
                try:
                    entries = _entries(inner)
                finally:
                    os.close(inner)
                for name, kind in entries:
                    record = path / name
                    partial = PARTIAL.fullmatch(name)
                    if partial is not None and stat.S_ISREG(kind) and layout.record(partial["name"]):
                        continue
                    if name.startswith("."):
                        refusals.append(f"{record} is a hidden name, and the held records hold none.")
                    elif not stat.S_ISREG(kind):
                        refusals.append(f"{record} is {kind_of(kind)}, and a held record is a plain file.")
                    elif not layout.record(name):
                        refusals.append(f"{record} is no held record: {where}.")
                    else:
                        planned.append((directory, name))
        if refusals:
            raise LayoutRefused(refusals)
        found: dict[str, frozenset[str]] = {}
        for directory, name in planned:
            path = shown / directory / name
            inner = os.open(directory, DIRECTORY_FLAGS, dir_fd=fd)
            try:
                data = read_bounded(inner, name, layout.json_bound, path)
            finally:
                os.close(inner)
            why = json_refusal(data)
            if why is not None:
                refusals.append(f"{path} {why}.")
                continue
            record = json.loads(data.decode("utf-8"))
            extra = record.get("extra") if isinstance(record, dict) else None
            if not isinstance(record, dict) or set(record) != {"extra"} or not isinstance(extra, list):
                refusals.append(f"{path} is not an object whose one key extra lists the files its comparison held.")
                continue
            outside = [
                entry
                for entry in extra
                if not isinstance(entry, str) or not layout.member(tree, tuple(entry.split("/")))
            ]
            if outside:
                shown_names = ", ".join(json.dumps(entry) for entry in outside[:10])
                refusals.append(f"{path} lists {shown_names}, which no directory of {tree}/ holds. {NAME_IT}")
                continue
            found[directory] = found.get(directory, frozenset()) | frozenset(extra)
        if refusals:
            raise LayoutRefused(refusals)
        return found
    finally:
        os.close(fd)


def read_base(directory: Path, layout: Layout | None = None) -> dict[str, bytes]:
    """The members of one base's directory (``hq-apps/<base>/``), read through the layout and nothing else of its
    tree; ``LayoutRefused`` where the directory is not a base's or does not exist."""
    directory = Path(directory)
    layout = layout or load()
    if not layout.directory("hq-apps", directory.name):
        raise LayoutRefused([f"{directory} is no base proof/matrix/bases.json lists. {NAME_IT}"])
    fd = open_directory(directory.parent)
    if fd is None:
        raise LayoutRefused([f"{directory.parent} does not exist, so it holds no base."])
    try:
        try:
            mode = os.stat(directory.name, dir_fd=fd, follow_symlinks=False).st_mode
        except FileNotFoundError:
            raise LayoutRefused([f"{directory} does not exist, so no base is there."]) from None
        if not stat.S_ISDIR(mode):
            raise LayoutRefused([f"{directory} is {kind_of(mode)}, and a base is a directory."])
        refusals: list[str] = []
        planned = {directory.name: _plan(fd, directory.parent, "hq-apps", directory.name, layout, refusals)}
        if refusals:
            raise LayoutRefused(refusals)
        return _read_planned(fd, directory.parent, "hq-apps", planned, layout)[directory.name]
    finally:
        os.close(fd)
