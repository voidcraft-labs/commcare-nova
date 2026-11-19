"""The changes Nova tells a person its publish makes in CommCare HQ, as the lane reads them
(``proof/first-publish-changes.json``, the first-publish register), and their judge.

Some of what Nova's publish over an app it reads from CommCare HQ changes there
is on purpose, and Nova says which before it sends anything
(``lib/deployment/reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES``, the
typed register). A shard holds no TypeScript, so the lane keeps this file
beside it: one object a change, in the register's order, each with the rows of
the differences the change allows, in the lane's own vocabulary::

    {"change": "case-names-checked",
     "rows": [{"check": "source", "artifact": "app.json", "path": "/modules/*/forms/*/actions"}]}

- A ``source`` row is one of the entry's paths in the typed register: a JSON
  Pointer over HQ's stored app, ``*`` for a position or an app's own key, that
  covers everything under it. It matches a ``source`` difference
  (``proof.checks.source``) whose concrete pointer (``at``) it covers.
- A ``proof1``, ``proof2`` or ``proof3`` row names a class as a known-defect
  entry does (``proof.checks.registers``): the check, the artifact (``*`` any
  run of characters), the exact structural path and, where it names one, the
  kind. Such a row is written from a document's own evidence (``rows``,
  below), never by typing a path.

An entry applies in two places, and on no other document and no control:

- on a document made in HQ, where its ``first-publish.json`` lists the id,
  which the emission writes from the reading: the changes Nova would tell the
  person this app's first publish makes;
- on a document whose saves in CommCare HQ Nova brings in (``hq-side.json``
  states the republish ``brings-in``), where Nova's review of those saves
  lists it for the next publish (the statement's ``publishChanges``, which the
  capture holds to the review's own list,
  ``proof/corpus/publish.ts::bringInOverPeer``).

A document made in HQ states no saves (``proof/corpus/entryWriter.ts`` refuses
both), so a document has one list or none. The judge is strict both ways
(``differences``): a difference no applying entry's row matches is held to the
spelling rules and the known-defect register like any other, and one a row of
an entry that does not apply matches is reported as ``/<id>/unsaid``; an
applying entry that matches nothing is ``/<id>/unseen``.

    python3 -m proof.checks.changes rows <output> <document>

prints, for each difference of the document's evidence in a lane run's output
that no row of an entry applying on it holds, the row that names it, which a
person writes under the entry whose change it shows.

Standard library only (``proof/CLAUDE.md``, "What runs with no image").
"""

from __future__ import annotations

import fnmatch
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from proof.checks.differences import KINDS, Difference, artifact_reader, served_artifact

PROOF_DIR = Path(__file__).resolve().parents[1]
FIRST_PUBLISH_CHANGES = PROOF_DIR / "first-publish-changes.json"
ROW_CHECKS = ("source", "proof1", "proof2", "proof3")
# The entry whose source rows also cover every pointer the claim log holds under an entry of standing ``inert``:
# Nova writes every form and setting in its own spelling, the settings no runtime reads among them.
INERT_ALLOWANCE = "forms-and-settings-rewritten"
CHANGE_KEYS = frozenset({"change", "rows"})
ROW_KEYS = frozenset({"check", "artifact", "path"})
OPTIONAL_ROW_KEYS = frozenset({"kind"})


class ChangesError(ValueError):
    """``proof/first-publish-changes.json`` is not a register the judge can hold differences to."""


@dataclass(frozen=True)
class Row:
    check: str  # "source", "proof1", "proof2" or "proof3"
    artifact: str
    path: str
    kind: str | None = None

    def matches(self, difference) -> bool:
        if difference.check != self.check or not fnmatch.fnmatchcase(difference.artifact, self.artifact):
            return False
        if self.kind is not None and difference.kind != self.kind:
            return False
        if self.check == "source":
            return covers(self.path, difference.at) or covers(self.path, difference.path)
        return difference.path == self.path

    def as_json(self):
        return {
            "check": self.check,
            "artifact": self.artifact,
            "path": self.path,
            **({"kind": self.kind} if self.kind is not None else {}),
        }


@dataclass(frozen=True)
class Change:
    change: str
    rows: tuple[Row, ...]


def tokens(pointer: str) -> list[str]:
    if pointer == "" or pointer == "/":
        return []
    if not pointer.startswith("/"):
        raise ChangesError(f"{pointer!r} is no JSON Pointer: a pointer starts with /.")
    return pointer[1:].split("/")


def covers(pattern: str, pointer: str) -> bool:
    """Whether a source row's pointer (``*`` one step of any name) covers ``pointer``: equal to it, or above it."""
    wanted, held = tokens(pattern), tokens(pointer)
    return len(wanted) <= len(held) and all(step in ("*", got) for step, got in zip(wanted, held, strict=False))


def _row(raw, where) -> Row:
    if not isinstance(raw, dict) or not ROW_KEYS <= set(raw) <= ROW_KEYS | OPTIONAL_ROW_KEYS:
        raise ChangesError(f"{where} holds {sorted(ROW_KEYS)} and optionally {sorted(OPTIONAL_ROW_KEYS)}: {raw!r}.")
    if raw["check"] not in ROW_CHECKS:
        raise ChangesError(
            f"{where} names the check {raw['check']!r}; a row is one of {', '.join(ROW_CHECKS)}. An intent"
            " difference says a reader read A wrongly or Nova's emission lost what the document states, never a"
            " declared change."
        )
    for key in ("artifact", "path"):
        if not isinstance(raw[key], str) or not raw[key]:
            raise ChangesError(f"{where}: {key} is a non-empty string.")
    if not raw["path"].startswith("/"):
        raise ChangesError(f"{where}: path {raw['path']!r} is a structural path from the artifact's root (/...).")
    kind = raw.get("kind")
    if kind is not None and kind not in KINDS:
        raise ChangesError(f"{where}: kind {kind!r} is one of {sorted(KINDS)}, or left out for every kind.")
    return Row(raw["check"], raw["artifact"], raw["path"], kind)


def parse(value, where="proof/first-publish-changes.json") -> tuple[Change, ...]:
    """The register's entries from the file's parsed JSON, in file order (``load``)."""
    if not isinstance(value, list):
        raise ChangesError(f"{where} is a list of {{change, rows}}, one object a change.")
    found, seen = [], set()
    for index, raw in enumerate(value):
        at = f"{where}[{index}]"
        if not isinstance(raw, dict) or set(raw) != CHANGE_KEYS:
            raise ChangesError(f"{at} holds exactly change and rows.")
        change = raw["change"]
        if not isinstance(change, str) or not change:
            raise ChangesError(f"{at}: change is a first-publish register id.")
        if change in seen:
            raise ChangesError(f"{where} holds two objects of the change {change}; one object a change holds its rows.")
        seen.add(change)
        if not isinstance(raw["rows"], list):
            raise ChangesError(f"{at}: rows is a list.")
        rows, classes = [], set()
        for number, row_raw in enumerate(raw["rows"]):
            row = _row(row_raw, f"{at}.rows[{number}]")
            if row in classes:
                raise ChangesError(
                    f"{at} names the class {row.check} {row.artifact} {row.path}"
                    f"{'' if row.kind is None else f' ({row.kind})'} twice; a row names a class once."
                )
            classes.add(row)
            rows.append(row)
        found.append(Change(change, tuple(rows)))
    return tuple(found)


def load(path: Path = FIRST_PUBLISH_CHANGES) -> tuple[Change, ...]:
    """The file's entries in file order. Refuses two objects of one change, two rows of one class within an object,
    and a check outside the four."""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ChangesError(f"{path} could not be read as JSON ({error}).") from error
    return parse(value, str(path))


def _applying(document) -> frozenset[str]:
    """The entries that apply on ``document``: on a document made in HQ, those its reading says the first publish
    makes (``corpus.Document.first_publish``); on a corpus document whose saves in CommCare HQ are brought in, the
    changes of the next publish Nova's review of them lists (``corpus.Document.next_publish``); none on any other
    document or on a control."""
    if getattr(document, "hq_authored", False):
        return frozenset(document.first_publish)
    if getattr(document, "kind", "corpus") == "control":
        return frozenset()
    return frozenset(getattr(document, "next_publish", ()) or ())


def under_inert(pointer: str, inert: frozenset[str]) -> bool:
    """Whether ``pointer`` is one the claim log holds under an entry of standing inert, or under one."""
    held = tokens(pointer)
    return any(
        len(tokens(claimed)) <= len(held) and tokens(claimed) == held[: len(tokens(claimed))] for claimed in inert
    )


def _held_by(difference, change: Change, inert: frozenset[str]) -> bool:
    if any(row.matches(difference) for row in change.rows):
        return True
    return (
        change.change == INERT_ALLOWANCE
        and difference.check == "source"
        and difference.artifact == "app.json"
        and under_inert(difference.at, inert)
    )


def declared(document, check: str, differences, *, inert: frozenset[str] = frozenset(), register=None):
    """``(held, ids)``: the differences of ``check`` a row of an entry applying on ``document`` matches, and the ids of
    the entries that matched. A ``source`` difference whose pointer is in ``inert`` (the pointers the claim log
    holds under an entry of standing inert, or under one) is matched by forms-and-settings-rewritten. On a document
    no entry applies on, nothing is held."""
    applying = _applying(document)
    if not applying:
        return [], frozenset()
    changes = [change for change in (load() if register is None else register) if change.change in applying]
    held, ids = [], set()
    for difference in differences:
        if difference.check != check:
            continue
        matched = [change.change for change in changes if _held_by(difference, change, inert)]
        if matched:
            held.append(difference)
            ids.update(matched)
    return held, frozenset(ids)


def undeclared(document, check: str, differences, *, inert: frozenset[str] = frozenset(), register=None):
    """``differences`` without those ``declared`` holds: what goes on to the spelling rules and the registers."""
    held, _ = declared(document, check, differences, inert=inert, register=register)
    kept = {id(difference) for difference in held}
    return [difference for difference in differences if id(difference) not in kept]


def _served_only(change: Change, readers) -> bool:
    """Whether every row of ``change`` names a served reader's artifact the run does not observe."""
    return bool(change.rows) and all(
        served_artifact(row.artifact) and artifact_reader(row.artifact) not in readers for row in change.rows
    )


def _unjudged(change: Change, checked) -> bool:
    """Whether no row of ``change`` names a check the judge was handed the differences of: a document whose saves are
    brought in is judged on proofs 1 to 3 alone, so an entry made only of ``source`` rows is left to a document made
    in HQ."""
    return all(row.check not in checked for row in change.rows)


def _changes_difference(document_id, change_id, what, at, before=None, after=None):
    path = f"/{change_id}/{what}"
    return Difference("changes", document_id, "register", path, at, "changed", before, after)


def differences(
    document,
    checked: Mapping[str, Sequence[Difference]],
    *,
    inert: frozenset[str] = frozenset(),
    readers,
    register=None,
) -> list[Difference]:
    """Holds 1 and 2 of the judge on one document. ``checked`` is every difference of the checks the judge is handed,
    by check (on a document made in HQ the four, ``source`` among them; on one whose saves are brought in, proofs 1
    to 3); ``inert`` is the pointers the claim log holds under an entry of standing inert (``declared``), none on a
    document not made in HQ; ``readers`` is the set of served readers the run observes
    (``proof.lane.readers.named``). Answers the ``changes`` differences ``/<id>/unsaid`` (a difference an entry
    that does not apply would match, and no applying one does) and ``/<id>/unseen`` (an applying entry that
    matched no difference, but where every row of it names a served reader the run does not observe, or a check
    the judge was not handed)."""
    applying = _applying(document)
    changes = list(load() if register is None else register)
    readers = frozenset(readers or ())
    found, seen = [], set()
    for check in ROW_CHECKS:
        for difference in checked.get(check, ()):
            matched = [change for change in changes if _held_by(difference, change, inert)]
            said = [change.change for change in matched if change.change in applying]
            seen.update(said)
            if said:
                continue
            for change in matched:
                found.append(
                    _changes_difference(
                        document.id,
                        change.change,
                        "unsaid",
                        f"/{change.change}/unsaid/{check}/{difference.artifact}{difference.at}",
                        None,
                        difference.as_json(),
                    )
                )
    by_id = {change.change: change for change in changes}
    for change_id in sorted(applying - seen):
        change = by_id.get(change_id)
        if change is not None and (_served_only(change, readers) or _unjudged(change, checked)):
            continue
        found.append(_changes_difference(document.id, change_id, "unseen", f"/{change_id}/unseen"))
    return found


def unsaid_message(document_id, difference: Difference) -> str:
    """A change Nova's publish made that its review would not have mentioned."""
    seen = difference.after or {}
    return (
        f"Publishing {document_id} to CommCare HQ changed something Nova's review would not have mentioned:"
        f" {difference.path.split('/')[1]}, seen at {seen.get('at')} by {seen.get('check')}. Either the change's"
        " rule in FIRST_PUBLISH_CHANGES misses this app, or the publish should not have changed it (on an app made"
        " in HQ, the reader should not have held the shape that caused it)."
    )


def unseen_message(document_id, difference: Difference) -> str:
    """A change Nova's review mentions that nothing the lane ran showed."""
    return (
        f"Nova's review of {document_id} says its publish makes the change {difference.path.split('/')[1]},"
        " and nothing the lane ran showed it. Either the rule fires where the change does not happen, or no row of"
        " the entry in proof/first-publish-changes.json names what this document shows."
    )


# The rows command ------------------------------------------------------------------


@dataclass(frozen=True)
class _Evidence:
    check: str
    artifact: str
    path: str
    at: str
    kind: str


def _evidence(output: Path, document: str):
    found = []
    for check in ROW_CHECKS:
        for path in sorted(output.glob(f"blocks/*/checks/{check}/corpus-{document}.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            for difference in record.get("differences") or []:
                found.append(
                    _Evidence(check, difference["artifact"], difference["path"], difference["at"], difference["kind"])
                )
    return found


def _held_file(output: Path, document: str, name: str):
    """The parsed ``name`` the run wrote under the document's corpus directory, or None where it wrote none."""
    for candidate in (
        output / "corpus" / document / name,
        *output.glob(f"blocks/*/corpus/{document}/{name}"),
    ):
        if candidate.is_file():
            return json.loads(candidate.read_text(encoding="utf-8"))
    return None


def _applying_in(output: Path, document: str) -> frozenset[str]:
    """The entries that apply on the document as the run's output holds it (``_applying``): the ids its
    ``first-publish.json`` lists, where it is made in HQ, and the changes of the next publish its ``hq-side.json``
    states its review lists, where it states the republish brings its saves in."""
    applying = set()
    first = _held_file(output, document, "first-publish.json")
    if isinstance(first, dict):
        applying.update(first.get("ids") or ())
    saves = _held_file(output, document, "hq-side.json")
    if isinstance(saves, dict) and saves.get("republish") == "brings-in":
        applying.update(saves.get("publishChanges") or ())
    return frozenset(applying)


def rows(output: Path, document: str, register=None) -> list[dict]:
    """For each difference of the document's evidence under ``output`` that no row of an entry applying on it holds,
    the row that names it: ``source`` by its structural path, the others by check, artifact, path and kind, each
    once, in the order of the evidence."""
    applying = _applying_in(output, document)
    changes = [change for change in (load() if register is None else register) if change.change in applying]
    printed, seen = [], set()
    for evidence in _evidence(output, document):
        if any(row.matches(evidence) for change in changes for row in change.rows):
            continue
        row = Row(
            evidence.check, evidence.artifact, evidence.path, None if evidence.check == "source" else evidence.kind
        )
        if row not in seen:
            seen.add(row)
            printed.append(row.as_json())
    return printed


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 3 or argv[0] != "rows":
        print(
            "Name a lane run's output and a document: python3 -m proof.checks.changes rows <output> <document>.",
            file=sys.stderr,
        )
        return 2
    output, document = Path(argv[1]), argv[2]
    if not output.is_dir():
        print(f"{output} is no directory a lane run wrote.", file=sys.stderr)
        return 2
    for row in rows(output, document):
        print(json.dumps(row, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
