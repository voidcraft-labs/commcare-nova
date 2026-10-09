"""The known-defect and identity-move registers, and the strict matching of decision 12.

``proof/known-defects.json`` lists each defect part the harness reproduces as
a symptom class::

    {"id", "defect", "part", "check", "artifact", "path", "document",
     "kind"?, "values"?, "control"}

- ``check``, ``artifact``, ``path`` and ``kind`` name the class: a
  difference is in it when its check is the entry's, its artifact matches
  the entry's (``*`` in the entry's artifact matches any run of characters,
  so ``form:*`` names every form), its structural path is exactly the
  entry's, and, where the entry names a ``kind`` (``changed``, ``added``,
  ``removed``, ``error`` or ``refused``), its kind is that one. The path is
  compared as written, never as a pattern: a structural path already writes
  every position and every name the app authored as ``*``
  (``proof.checks.differences``), so ``case[*]`` in an entry is that step
  itself, and a symptom has the one path on every document. An entry without
  ``kind`` holds every kind at its path; one with it holds only that kind, so
  a removed constraint and a changed one are two entries.
- ``document`` is a corpus document whose current export must show it: a
  targeted one, or one the corpus holds whatever the fuzz sample's size,
  never one of the fuzz sample, which holds only the documents its size and
  seed draw.
- ``values`` (``{"before", "after"}``), only on an entry whose document is a
  targeted one, pins the exact values; such an entry matches only there, and
  owns what it matches, so a class's unpinned entry holds none of it
  (``reconcile``).
- An entry whose artifact is ``android@...`` is the Android stage's (``stage``): a difference in what
  CommCare Android's own code read of two archives (``proof.checks.android``), which that stage's judge of
  the entry's check reports and holds, on the entry's document and on its control. Every other entry is the
  shards'. What a defect does on a device is such an entry, never a citation of Android's source.
- An entry is a symptom, never an equivalence: two spellings every reader of which reads alike are a spelling
  rule, proven by tests that run each of those readers on both (``proof.rules``, CommCare Android among them,
  ``proof/android/predicates.py``), and the register holds no entry for them.
- A ``manifest`` entry never names an undecided use
  (``/<key>/undecided/<value class>``, ``proof.checks.manifest_usage.standing``):
  the check could not place the use in or out of a REFUSED value class, a gap
  in the check that a value class reader closes, not a symptom of the export.
- ``control`` is the directory under ``proof/controls/`` retaining the
  pre-fix inputs the check must keep showing the symptom on.

A check passes only when every difference it reports on a document falls in
a registered class, and every entry naming that document and check matches
at least one of them that no other entry holds (``reconcile``); so a new
failure fails, a fixed defect left listed fails until its entry is removed,
and a register with any one entry removed fails. An entry names one of the
checks a test holds to the register (``HELD_CHECKS``); and over a whole run
of the lane, every shard's evidence together (``verify_evidence``, run as
``python -m proof.checks.registers verify <output>/blocks/*``), every
entry must have been seen on its document and on its control, so an entry
whose check never ran there fails too. A run over a sample of the corpus
(``proof.store.queue.sampled``) holds an entry naming a document the sample
leaves out on its control alone, the one place that run can show it; the
gate reads the documents left out from the run's queue
(``proof.lane.gate``).

``PROOF_KNOWN_DEFECTS`` names another register file in place of
``proof/known-defects.json``: a harness self-test's run over a corpus of its
own holds that run to a register of its own.

``proof/identity-moves.json`` lists ``{"defect", "entity", "path"}``: an
identity change a migration decides, which proof 1 accepts (``entity``
matches a difference's artifact as an entry's artifact does, ``path`` its
structural path). It is empty until a step decides one.
"""

from __future__ import annotations

import fnmatch
import json
import os
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path

from proof.checks.differences import CHECKS, KINDS, Difference

# The checks whose differences a test holds to the register (each one's test
# module calls ``proof.checks.cases.hold``). An entry naming another check
# could never be matched, so the register refuses it.
HELD_CHECKS = frozenset(
    {
        "bar",
        "intent",
        "manifest",
        "proof1",
        "proof2",
        "proof3",
        "proof4",
        "proof5",
        "sensitivity",
    }
)

PROOF_DIR = Path(__file__).resolve().parents[1]
KNOWN_DEFECTS = PROOF_DIR / "known-defects.json"
IDENTITY_MOVES = PROOF_DIR / "identity-moves.json"
CONTROLS = PROOF_DIR / "controls"

ENTRY_KEYS = frozenset({"id", "defect", "part", "check", "artifact", "path", "document", "control"})
OPTIONAL_KEYS = frozenset({"kind", "values"})
MOVE_KEYS = frozenset({"defect", "entity", "path"})


# The step of a manifest path that names a use the check could not place in or out of a REFUSED value class
# (proof.checks.manifest_usage.UNDECIDED, written /<key>/undecided/<value class>).
UNDECIDED_STEP = "undecided"


def _undecided(path):
    steps = path.split("/")
    return len(steps) > 2 and steps[2] == UNDECIDED_STEP


class RegisterError(ValueError):
    """A register file is not one the checks can hold every difference to."""


@dataclass(frozen=True)
class Entry:
    id: str
    defect: int
    part: str
    check: str
    artifact: str
    path: str
    document: str
    control: str
    kind: str | None = None
    values: dict | None = None

    @property
    def stage(self) -> str:
        """Which stage of the lane shows the entry's class: ``android`` for an artifact the Android stage's
        judges report (``android@...``, ``proof.checks.android``), else ``lane``, the shards' own checks."""
        return stage_of(self.artifact)

    def matches(self, difference) -> bool:
        if difference.check != self.check or difference.path != self.path:
            return False
        if self.kind is not None and difference.kind != self.kind:
            return False
        if not fnmatch.fnmatchcase(difference.artifact, self.artifact):
            return False
        if self.values is not None:
            return (
                difference.document == self.document
                and difference.before == self.values["before"]
                and difference.after == self.values["after"]
            )
        return True


# The two stages a check's differences on one document come from: the shards' own check (``lane``), and the
# Android stage's judge of the same check over what CommCare Android read (``android``). Each writes its
# evidence apart and holds it to the entries of its own stage, and the gate holds both together.
LANE, ANDROID = "lane", "android"
ANDROID_ARTIFACT = "android@"


def stage_of(artifact: str) -> str:
    return ANDROID if artifact.startswith(ANDROID_ARTIFACT) else LANE


def of_stage(entries, stage: str):
    return tuple(entry for entry in entries if entry.stage == stage)


def _kind(entry):
    """How a message names an entry's kind: `` (removed)``, or nothing where it holds every kind."""
    return "" if entry.kind is None else f" ({entry.kind})"


@dataclass(frozen=True)
class IdentityMove:
    defect: int
    entity: str
    path: str

    def accepts(self, difference) -> bool:
        return (
            difference.check == "proof1"
            and difference.path == self.path
            and fnmatch.fnmatchcase(difference.artifact, self.entity)
        )


def _load_list(path: Path, what: str):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RegisterError(f"The {what} register {path} does not exist; it holds a list ([] when empty).") from error
    except json.JSONDecodeError as error:
        raise RegisterError(f"The {what} register {path} is not JSON ({error}).") from error
    if not isinstance(value, list):
        raise RegisterError(f"The {what} register {path} holds a list of entries.")
    return value


def known_defects_path() -> Path:
    """The register a run holds its differences to: ``PROOF_KNOWN_DEFECTS`` where the run names one, else
    ``proof/known-defects.json``."""
    named = os.environ.get("PROOF_KNOWN_DEFECTS")
    return Path(named) if named else KNOWN_DEFECTS


def load_known_defects(
    path: Path | None = None, *, documents=None, targeted=None, fuzz=None, controls: Path = CONTROLS
):
    """The known-defect register (``known_defects_path`` unless ``path`` names one), each entry checked for what
    decision 12 needs of it.

    ``documents`` (the corpus's document ids), ``targeted`` (the ids of its
    targeted documents) and ``fuzz`` (the ids of its fuzz sample's), when
    given, are what each entry's ``document`` must and must not name;
    ``controls`` is where each entry's control must be.
    """
    path = known_defects_path() if path is None else path
    entries, problems = [], []
    seen = set()
    for index, raw in enumerate(_load_list(path, "known-defect")):
        where = f"{path.name} entry {index}"
        if not isinstance(raw, dict):
            problems.append(f"{where} is not an object.")
            continue
        where = f"{path.name} entry {raw.get('id', index)!r}"
        unknown = set(raw) - ENTRY_KEYS - OPTIONAL_KEYS
        missing = ENTRY_KEYS - set(raw)
        if unknown or missing:
            problems.append(
                f"{where} holds {sorted(ENTRY_KEYS)} and optionally {sorted(OPTIONAL_KEYS)};"
                f" it has {sorted(unknown)} beyond them and lacks {sorted(missing)}."
            )
            continue
        for key in ENTRY_KEYS - {"defect"}:
            if not isinstance(raw[key], str) or not raw[key]:
                problems.append(f"{where}: {key} is a non-empty string.")
        if not isinstance(raw["defect"], int) or isinstance(raw["defect"], bool):
            problems.append(f"{where}: defect is the research's defect number.")
        if raw.get("check") not in CHECKS:
            problems.append(f"{where}: check {raw.get('check')!r} is not one of {sorted(CHECKS)}.")
        elif raw["check"] not in HELD_CHECKS:
            problems.append(
                f"{where}: check {raw['check']!r} has no test holding its differences to the register yet (the"
                f" held checks are {sorted(HELD_CHECKS)}), so nothing could ever show the entry's symptom."
            )
        if isinstance(raw.get("path"), str) and not raw["path"].startswith("/"):
            problems.append(f"{where}: path {raw['path']!r} is a structural path from the artifact's root (/…).")
        if raw.get("check") == "manifest" and isinstance(raw.get("path"), str) and _undecided(raw["path"]):
            problems.append(
                f"{where}: path {raw['path']!r} is a use the manifest check could not place in or out of a REFUSED"
                " value class, which is a gap in the check rather than a symptom a register entry holds. Write that"
                " class's reader in proof/checks/manifest_value_classes.py (VALUE_CLASSES, by the id of the"
                " inventory entry the difference names), so the check reads the use as refused or held."
            )
        if raw.get("id") in seen:
            problems.append(f"{where}: two entries share the id {raw['id']!r}.")
        seen.add(raw.get("id"))
        if "values" in raw:
            values = raw["values"]
            if not isinstance(values, dict) or set(values) != {"before", "after"}:
                problems.append(f"{where}: values holds exactly before and after.")
            elif targeted is not None and raw.get("document") not in targeted:
                problems.append(
                    f"{where} pins values on {raw.get('document')!r}, which is not a targeted document: exact values"
                    " belong only to a document whose values are fixed by hand (decision 12)."
                )
        if "kind" in raw and raw["kind"] not in KINDS:
            problems.append(f"{where}: kind {raw['kind']!r} is one of {sorted(KINDS)}, or left out for every kind.")
        if documents is not None and raw.get("document") not in documents:
            problems.append(f"{where} names the document {raw.get('document')!r}, which the corpus does not hold.")
        elif fuzz is not None and raw.get("document") in fuzz:
            problems.append(
                f"{where} names the document {raw.get('document')!r}, which is one of the fuzz sample's: the sample"
                " holds only what its size and seed draw, so the entry would fail when either changes. Name a"
                " producer, workforce, expander or targeted document that shows the symptom, or write a targeted one."
            )
        if isinstance(raw.get("control"), str) and not (controls / raw["control"]).is_dir():
            problems.append(
                f"{where} names the control {raw['control']!r}, and {controls / raw['control']} does not exist."
            )
        if not any(problem.startswith(where) for problem in problems):
            entries.append(Entry(**{key: raw.get(key) for key in (*ENTRY_KEYS, *OPTIONAL_KEYS)}))
    if problems:
        raise RegisterError("The known-defect register is not one the checks can hold to:\n  " + "\n  ".join(problems))
    return tuple(entries)


def load_identity_moves(path: Path = IDENTITY_MOVES):
    moves, problems = [], []
    for index, raw in enumerate(_load_list(path, "identity-move")):
        if not isinstance(raw, dict) or set(raw) != MOVE_KEYS:
            problems.append(f"{path.name} entry {index} holds exactly {sorted(MOVE_KEYS)}.")
            continue
        if not isinstance(raw["defect"], int) or not all(isinstance(raw[k], str) for k in ("entity", "path")):
            problems.append(f"{path.name} entry {index}: defect is a number, entity and path are strings.")
            continue
        moves.append(IdentityMove(raw["defect"], raw["entity"], raw["path"]))
    if problems:
        raise RegisterError("The identity-move register is not one proof 1 can accept by:\n  " + "\n  ".join(problems))
    return tuple(moves)


@dataclass
class Reconciliation:
    """How one check's differences on one document meet the register."""

    check: str
    document: str
    registered: dict = field(default_factory=dict)  # entry id -> [Difference]
    unregistered: list = field(default_factory=list)
    unseen: list = field(default_factory=list)  # entries for this document and check that matched nothing
    # Entries for this document and check whose every difference another entry also holds, so the
    # register would pass without them.
    redundant: list = field(default_factory=list)

    @property
    def holds(self):
        return not self.unregistered and not self.unseen and not self.redundant

    def explain(self):
        from proof.checks.differences import summary

        lines = []
        if self.unregistered:
            lines.append(
                f"{self.check} on {self.document} found differences no known-defect entry names"
                " (a new failure: fix it, or register its class with a targeted document and a control):"
            )
            lines.append(summary(self.unregistered))
        for entry in self.redundant:
            lines.append(
                f"The known-defect entry {entry.id} names {entry.check} {entry.artifact} {entry.path}{_kind(entry)} on"
                f" {entry.document}, and every difference it matches there another entry also names, so removing"
                " it would change nothing: each entry must be the only one holding some difference."
            )
        for entry in self.unseen:
            lines.append(
                f"The known-defect entry {entry.id} (defect {entry.defect}, {entry.part}) names {entry.check}"
                f" {entry.artifact} {entry.path}{_kind(entry)} on {entry.document}, and {entry.check} no longer"
                " shows it there."
                " If the defect is fixed, remove the entry in the same change."
            )
        return "\n".join(lines)


def reconcile(check, document, differences, entries):
    """Match one check's differences on one document to the register (decision 12)."""
    result = Reconciliation(check, document)
    for difference in differences:
        owners = [entry for entry in entries if entry.matches(difference)]
        # An entry that pins the exact values on its targeted document is the narrower claim, so a difference it
        # holds is its alone: a class's unpinned entry, which holds the class wherever else it shows, holds none
        # of the pinned entry's, and neither entry is left redundant by the other.
        pinned = [entry for entry in owners if entry.values is not None]
        owners = pinned or owners
        if not owners:
            result.unregistered.append(difference)
        for entry in owners:
            result.registered.setdefault(entry.id, []).append(difference)
    owners_of = {}
    for entry_id, matched in result.registered.items():
        for difference in matched:
            owners_of.setdefault(id(difference), set()).add(entry_id)
    for entry in entries:
        if entry.check != check or entry.document != document:
            continue
        matched = result.registered.get(entry.id)
        if not matched:
            result.unseen.append(entry)
        elif all(len(owners_of[id(difference)]) > 1 for difference in matched):
            result.redundant.append(entry)
    return result


def accepted_moves(differences, moves):
    """Split proof 1's differences into those an identity move accepts and the rest."""
    accepted, rest = [], []
    for difference in differences:
        (accepted if any(move.accepts(difference) for move in moves) else rest).append(difference)
    return accepted, rest


def _evidence(directories):
    """Each check's differences on each document (``proof.checks.cases.evidence``), by (check, kind, id): the
    shards' own and the Android stage's together (an evidence record's ``stage``), with which stages wrote
    (``stages``, by the same key)."""
    records, stages, problems = {}, {}, []
    for directory in directories:
        for path in sorted(Path(directory, "checks").glob("*/*.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            key = (record["check"], record["kind"], record["document"])
            stage = record.get("stage", LANE)
            if stage in stages.setdefault(key, set()):
                problems.append(
                    f"Two runs wrote the {stage} evidence of {record['check']} on {record['document']} ({path})."
                )
            stages[key].add(stage)
            records.setdefault(key, []).extend(Difference(**difference) for difference in record["differences"])
    return records, stages, problems


def verify_evidence(directories, entries, *, unsampled=frozenset(), stages=(LANE, ANDROID)):
    """Why a whole run of the lane does not hold to the register (decision 12), as person-readable problems.

    Read from the evidence every check wrote (``$PROOF_OUT/checks/<check>/``
    of each block, ``<output>/blocks/<id>/``): every difference on a corpus document falls in a
    registered class with every entry for that document needed
    (``reconcile``), and every entry was seen on its document and on its
    control, which fails when the check never ran on either. ``unsampled``
    names the corpus documents a run over a sample left out: an entry naming
    one is held on its control alone, and none ran on its document. ``stages`` names the stages whose entries
    the run holds (an unseeded lane runs no Android stage, ``proof.lane.gate``).
    """
    held_stages = frozenset(stages)
    entries = [entry for entry in entries if entry.stage in held_stages]
    records, stages, problems = _evidence(directories)
    if not records:
        return ["No check wrote evidence, so nothing shows the register holds; look for PROOF_OUT in the run."]
    for (check, kind, document), differences in sorted(records.items()):
        if kind == "corpus":
            # Each stage's evidence is held to its own entries; a stage that wrote none for the document holds
            # none of them here, and each of its entries is then reported below as not run.
            wrote = stages[(check, kind, document)]
            result = reconcile(check, document, differences, [entry for entry in entries if entry.stage in wrote])
            if not result.holds:
                problems.append(result.explain())
    for entry in entries:
        ran = "no shard" if entry.stage == LANE else "the Android stage never"
        shown = entry.stage in stages.get((entry.check, "corpus", entry.document), ())
        if not shown and entry.document not in unsampled:
            problems.append(
                f"The known-defect entry {entry.id} names {entry.check} on {entry.document}, and {ran} ran"
                f" {entry.check} on {entry.document}, so nothing shows the defect is still there."
            )
        on_control = (
            records.get((entry.check, "control", entry.control))
            if entry.stage in stages.get((entry.check, "control", entry.control), ())
            else None
        )
        if on_control is None:
            problems.append(
                f"The known-defect entry {entry.id} retains its control {entry.control}, and {ran} ran"
                f" {entry.check} on it, so nothing shows the check still sees the symptom there."
            )
        elif not any(entry.matches(replace(d, document=entry.document)) for d in on_control):
            problems.append(
                f"The known-defect entry {entry.id}'s control {entry.control} no longer shows {entry.check}"
                f" {entry.artifact} {entry.path}{_kind(entry)}."
            )
    return problems


def main(argv):
    if len(argv) < 2 or argv[0] != "verify":
        print(
            "Usage: python -m proof.checks.registers verify <block directory>... (each block's PROOF_OUT,"
            " <output>/blocks/* of a run)",
            file=sys.stderr,
        )
        return 2
    problems = verify_evidence(argv[1:], load_known_defects())
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
