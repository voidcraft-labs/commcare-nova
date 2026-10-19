"""The three registers (known defects, fixed defects and identity moves), and the strict matching of decision 12.

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
- An entry whose artifact is ``android@...`` is a difference in what CommCare Android's own code made of two
  states a shard handed a device (``proof.checks.android``), reported and held by the entry's check like
  every other entry's. What a defect does on a device is such an entry, never a citation of Android's
  source.
- An entry is a symptom, never an equivalence: two spellings every reader of which reads alike are a spelling
  rule, proven by tests that run each of those readers on both (``proof.rules``, CommCare Android among them,
  ``proof/android/predicates.py``), and the register holds no entry for them.
- A ``manifest`` entry never names an undecided use
  (``/<key>/undecided/<value class>``, ``proof.checks.manifest_usage.standing``):
  the check could not place the use in or out of a REFUSED value class, a gap
  in the check that a value class reader closes, not a symptom of the export.
- ``control`` is the directory under ``proof/controls/`` retaining the
  pre-fix inputs the check must keep showing the symptom on.
- An entry whose artifact is a served reader's (``served_entry``: its first step one of
  ``proof.checks.differences.SERVED_ARTIFACTS``, the names every check reports a reader's difference under) can be
  shown only by a run that hands its states to the readers. A run without them (``PROOF_READERS=0``, the pull
  request lane's, ``proof.lane.readers``) leaves such entries to the nightly run, which holds them: its checks hold
  their differences to the other entries alone (``proof.checks.cases.load_register``), and the gate holds the run's
  evidence to those (``verify_evidence``'s ``readers``).

A check passes only when every difference it reports on a document falls in
a registered class, and every entry naming that document and check matches
at least one of them that no other entry holds (``reconcile``); so a new
failure fails, a fixed defect left listed fails until its entry moves to the
fixed register, and a register with any one entry removed fails. An entry names one of the
checks a test holds to the register (``HELD_CHECKS``); and over a whole run
of the lane, every shard's evidence together (``verify_evidence``, run as
``python -m proof.checks.registers verify <output>/blocks/*``), every
entry must have been seen on its document and on its control, and every
fixed entry on its control, so an entry whose check never ran there fails
too. A run over a sample of the corpus
(``proof.store.queue.sampled``) holds an entry naming a document the sample
leaves out on its control alone, the one place that run can show it; the
gate reads the documents left out from the run's queue
(``proof.lane.gate``).

``proof/fixed-defects.json`` lists the entries a fix moved out of the
known-defect register, each a known-defect entry without ``document`` that
keeps the id it had (``[]`` when empty; the file must exist). A fixed entry is
held on its control alone, by every run that runs its control: the check
still shows the symptom on the retained pre-fix inputs, which is what catches
a fix that also blinds the check. It is never an owner on a corpus document:
a difference there in a fixed entry's class is unregistered like any other,
and its message says which fixed defect's class it is (``reconcile``). An id
is in one register only, no two fixed entries hold one class on one control,
and every directory under ``proof/controls/`` is named by an entry of one of
the two registers.

``PROOF_KNOWN_DEFECTS`` names another register file in place of
``proof/known-defects.json``: a harness self-test's run over a corpus of its
own holds that run to a register of its own, and to the fixed register
``fixed-defects.json`` beside it, read as empty where there is none
(``fixed_defects_path``).

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

from proof.checks.differences import CHECKS, KINDS, Difference, artifact_reader, served_artifact

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

# Each defect the known-defect register may hold, mapped to the later step that owns its fix: step 2 fixed
# every other numbered defect and finding it registered, so an entry of any of them is a regression or a fix left
# listed (``test_registers.test_every_live_defect_is_a_later_steps``). Registering another defect adds it here
# with its step. Finding 75 is the harness finding (numbered from 31) left open: its device half is fixed, and
# its search half is held by entries that stay live until its CSQL fix.
OPEN_DEFECTS = {
    20: 4,
    21: 5,
    23: 5,
    24: 5,
    25: 5,
    26: 5,
    27: 5,
    28: 5,
    30: 5,
    75: 3,
}

PROOF_DIR = Path(__file__).resolve().parents[1]
KNOWN_DEFECTS = PROOF_DIR / "known-defects.json"
FIXED_DEFECTS = PROOF_DIR / "fixed-defects.json"
IDENTITY_MOVES = PROOF_DIR / "identity-moves.json"
CONTROLS = PROOF_DIR / "controls"

ENTRY_KEYS = frozenset({"id", "defect", "part", "check", "artifact", "path", "document", "control"})
# A fixed entry names no document: it is held on its control alone.
FIXED_KEYS = ENTRY_KEYS - {"document"}
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
    # None for a fixed entry, which names its control alone.
    document: str | None
    control: str
    kind: str | None = None
    values: dict | None = None

    def matches(self, difference) -> bool:
        if difference.check != self.check or difference.path != self.path:
            return False
        if self.kind is not None and difference.kind != self.kind:
            return False
        if not fnmatch.fnmatchcase(difference.artifact, self.artifact):
            return False
        if self.values is not None:
            return (
                (self.document is None or difference.document == self.document)
                and difference.before == self.values["before"]
                and difference.after == self.values["after"]
            )
        return True

    def shares_class(self, other) -> bool:
        """Whether this entry and ``other`` name one check and one path over artifacts some difference could be
        named by both of (some artifact name matches both patterns)."""
        return self.check == other.check and self.path == other.path and globs_meet(self.artifact, other.artifact)


def globs_meet(one: str, other: str) -> bool:
    """Whether some name matches both artifact patterns, each spelled with ``*`` (any run of characters) and ``?``
    (any one character) and nothing else: ``form:*@vellum@*`` and ``form:0.0@*`` meet at ``form:0.0@vellum@x``,
    though neither matches the other as written."""
    reached = {(0, 0)}
    pending = [(0, 0)]
    while pending:
        i, j = pending.pop()
        if i == len(one) and j == len(other):
            return True
        steps = []
        if i < len(one) and one[i] == "*":
            steps.append((i + 1, j))
            if j < len(other):
                steps.append((i, j + 1))
        if j < len(other) and other[j] == "*":
            steps.append((i, j + 1))
            if i < len(one):
                steps.append((i + 1, j))
        if i < len(one) and j < len(other) and "*" not in (one[i], other[j]):
            if one[i] == other[j] or "?" in (one[i], other[j]):
                steps.append((i + 1, j + 1))
        for step in steps:
            if step not in reached:
                reached.add(step)
                pending.append(step)
    return False


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


def served_entry(entry) -> bool:
    """Whether a register entry (an ``Entry``, or an entry's raw object) names a served reader's artifact, which
    only a run with the readers can show (``proof.checks.differences.served_artifact``)."""
    artifact = entry.get("artifact") if isinstance(entry, dict) else entry.artifact
    return isinstance(artifact, str) and served_artifact(artifact)


def held_entries(entries, *, readers=True):
    """The entries a run holds: those whose artifacts no served reader writes, and those whose reader the run
    observes. ``readers`` is the set it observes (``proof.lane.readers``), true for every reader and false for
    none; the nightly holds the rest."""
    if readers is True:
        return tuple(entries)
    observed = frozenset() if readers is False else frozenset(readers)

    def held(entry):
        artifact = entry.get("artifact") if isinstance(entry, dict) else entry.artifact
        return not served_entry(entry) or artifact_reader(artifact) in observed

    return tuple(entry for entry in entries if held(entry))


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


def fixed_defects_path() -> Path:
    """The fixed register a run holds its controls to: ``fixed-defects.json`` beside the register
    ``PROOF_KNOWN_DEFECTS`` names where the run names one (a harness self-test's, which may hold none), else
    ``proof/fixed-defects.json``."""
    named = os.environ.get("PROOF_KNOWN_DEFECTS")
    return Path(named).parent / FIXED_DEFECTS.name if named else FIXED_DEFECTS


def _misshapen(raw, keys) -> bool:
    """Whether a raw entry lacks one of ``keys`` or holds a key beyond them and the optional ones."""
    return bool(set(raw) - keys - OPTIONAL_KEYS or keys - set(raw))


def _field_problems(raw, where, keys, *, controls):
    """Why one raw entry of either register is not one a check can hold, one line each: the fields every entry
    carries (``keys``) and the optional ones, the check, the path, the kind, the values' shape, and the control."""
    if _misshapen(raw, keys):
        return [
            f"{where} holds {sorted(keys)} and optionally {sorted(OPTIONAL_KEYS)};"
            f" it has {sorted(set(raw) - keys - OPTIONAL_KEYS)} beyond them and lacks {sorted(keys - set(raw))}."
        ]
    problems = []
    for key in keys - {"defect"}:
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
    if "values" in raw:
        values = raw["values"]
        if not isinstance(values, dict) or set(values) != {"before", "after"}:
            problems.append(f"{where}: values holds exactly before and after.")
    if "kind" in raw and raw["kind"] not in KINDS:
        problems.append(f"{where}: kind {raw['kind']!r} is one of {sorted(KINDS)}, or left out for every kind.")
    if isinstance(raw.get("control"), str) and not (controls / raw["control"]).is_dir():
        problems.append(
            f"{where} names the control {raw['control']!r}, and {controls / raw['control']} does not exist."
        )
    return problems


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
        problems += _field_problems(raw, where, ENTRY_KEYS, controls=controls)
        if _misshapen(raw, ENTRY_KEYS):
            continue
        if raw.get("id") in seen:
            problems.append(f"{where}: two entries share the id {raw['id']!r}.")
        seen.add(raw.get("id"))
        if (
            isinstance(raw.get("values"), dict)
            and set(raw["values"]) == {"before", "after"}
            and targeted is not None
            and raw.get("document") not in targeted
        ):
            problems.append(
                f"{where} pins values on {raw.get('document')!r}, which is not a targeted document: exact values"
                " belong only to a document whose values are fixed by hand (decision 12)."
            )
        if documents is not None and raw.get("document") not in documents:
            problems.append(f"{where} names the document {raw.get('document')!r}, which the corpus does not hold.")
        elif fuzz is not None and raw.get("document") in fuzz:
            problems.append(
                f"{where} names the document {raw.get('document')!r}, which is one of the fuzz sample's: the sample"
                " holds only what its size and seed draw, so the entry would fail when either changes. Name a"
                " producer, workforce, expander or targeted document that shows the symptom, or write a targeted one."
            )
        if not any(problem.startswith(where) for problem in problems):
            entries.append(Entry(**{key: raw.get(key) for key in (*ENTRY_KEYS, *OPTIONAL_KEYS)}))
    if problems:
        raise RegisterError("The known-defect register is not one the checks can hold to:\n  " + "\n  ".join(problems))
    return tuple(entries)


def load_fixed_defects(path: Path | None = None, *, known=(), controls: Path = CONTROLS):
    """The fixed-defect register (``fixed_defects_path`` unless ``path`` names one), each entry checked as a known
    one is, without a document: its fields, its check, its path, its kind and its control. ``known`` is the whole
    known-defect register, whose ids no fixed entry may carry: an id is in one register only. No two fixed
    entries hold one class (check, artifact, path, kind and values) on one control.

    A fixed register beside one ``PROOF_KNOWN_DEFECTS`` names is read as empty where there is none; the lane's
    own, ``proof/fixed-defects.json``, must exist."""
    if path is None:
        path = fixed_defects_path()
        if os.environ.get("PROOF_KNOWN_DEFECTS") and not path.exists():
            return ()
    known_ids = {entry.id for entry in known}
    entries, problems = [], []
    seen, classes = set(), {}
    for index, raw in enumerate(_load_list(path, "fixed-defect")):
        where = f"{path.name} entry {index}"
        if not isinstance(raw, dict):
            problems.append(f"{where} is not an object.")
            continue
        where = f"{path.name} entry {raw.get('id', index)!r}"
        if "document" in raw:
            problems.append(
                f"{where} names a document, and a fixed entry names none: it is held on its control alone, and a"
                " difference of its class on a document is a regression, which fails as one no entry holds."
            )
            continue
        problems += _field_problems(raw, where, FIXED_KEYS, controls=controls)
        if _misshapen(raw, FIXED_KEYS):
            continue
        if raw.get("id") in seen:
            problems.append(f"{where}: two entries share the id {raw['id']!r}.")
        seen.add(raw.get("id"))
        if raw.get("id") in known_ids:
            problems.append(
                f"{where}: the known-defect register holds an entry of the id {raw['id']!r} too. An id is in one"
                " register only: a fix moves its entry, and removes it from proof/known-defects.json."
            )
        shape = (
            raw.get("check"),
            raw.get("artifact"),
            raw.get("path"),
            raw.get("kind"),
            json.dumps(raw.get("values"), sort_keys=True),
            raw.get("control"),
        )
        if shape in classes:
            problems.append(
                f"{where} holds the class {classes[shape]!r} holds, on the same control: one of the two shows"
                " nothing the other does not, so remove it."
            )
        classes.setdefault(shape, raw.get("id"))
        if not any(problem.startswith(where) for problem in problems):
            entries.append(Entry(document=None, **{key: raw.get(key) for key in (*FIXED_KEYS, *OPTIONAL_KEYS)}))
    if problems:
        raise RegisterError("The fixed-defect register is not one the checks can hold to:\n  " + "\n  ".join(problems))
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
    # Fixed entries some unregistered difference falls in the class of: what the failure message names.
    returned: list = field(default_factory=list)

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
        for entry in self.returned:
            lines.append(
                f"Some of them are in the class of fixed defect {entry.defect} ({entry.id}: {entry.check}"
                f" {entry.artifact} {entry.path}{_kind(entry)}): the defect is back, or this is a new symptom in the"
                " same class."
            )
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
                " If the defect is fixed, move the entry to proof/fixed-defects.json, without its document, in the"
                " same change."
            )
        return "\n".join(lines)


def reconcile(check, document, differences, entries, *, fixed=()):
    """Match one check's differences on one document to the register (decision 12). ``fixed`` (the fixed
    register) owns nothing here: it only names the fixed defect whose class an unregistered difference is in."""
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
    result.returned = [entry for entry in fixed if any(entry.matches(d) for d in result.unregistered)]
    return result


def accepted_moves(differences, moves):
    """Split proof 1's differences into those an identity move accepts and the rest."""
    accepted, rest = [], []
    for difference in differences:
        (accepted if any(move.accepts(difference) for move in moves) else rest).append(difference)
    return accepted, rest


def _evidence(directories):
    """Each check's differences on each document (``proof.checks.cases.evidence``), by (check, kind, id), and each
    problem reading them with the group it names."""
    records, problems = {}, []
    for directory in directories:
        for path in sorted(Path(directory, "checks").glob("*/*.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            key = (record["check"], record["kind"], record["document"])
            if key in records:
                problems.append(
                    (
                        f"Two runs wrote the evidence of {record['check']} on {record['document']} ({path}).",
                        (f"{record['kind']}:{record['document']}",),
                    )
                )
            records.setdefault(key, []).extend(Difference(**difference) for difference in record["differences"])
    return records, problems


def held_fixed(fixed, *, readers=True, selected=None, ran_controls=None):
    """The fixed entries a run holds, each on its control: those of the readers it observes (``held_entries``),
    and, in a run over documents named by hand (``selected``), only those whose control it ran
    (``ran_controls``): a fixed entry names no document, so its control's own run is what brings it into such a
    run. A whole run and a sampled one run every control, and hold every one."""
    held = held_entries(fixed, readers=readers)
    if selected is None:
        return held
    ran = frozenset(ran_controls or ())
    return tuple(entry for entry in held if entry.control in ran)


def held_evidence(
    directories, entries, *, unsampled=frozenset(), readers=True, selected=None, fixed=(), ran_controls=None
):
    """``verify_evidence``'s problems, each with the lane's groups a rerun of which shows it again: the document's
    (``corpus:<id>``) where a check's differences on it do not hold or an entry was not seen on it, the control's
    (``control:<id>``) where an entry's control, live or fixed, did not run or no longer shows it; none where no
    one group does. ``fixed`` is the whole fixed register, which names the class an unregistered difference is in
    (``reconcile``); the run holds those ``held_fixed`` gives."""
    entries = held_entries(entries, readers=readers)
    records, problems = _evidence(directories)
    if not records:
        return [("No check wrote evidence, so nothing shows the register holds; look for PROOF_OUT in the run.", ())]
    for (check, kind, document), differences in sorted(records.items()):
        if kind == "corpus":
            result = reconcile(check, document, differences, entries, fixed=fixed)
            if not result.holds:
                problems.append((result.explain(), (f"corpus:{document}",)))
    for entry in entries:
        if selected is not None and entry.document not in selected:
            # A class a selected document's differences may fall in (above); its own document and control are no
            # part of this run.
            continue
        shown = (entry.check, "corpus", entry.document) in records
        if not shown and entry.document not in unsampled:
            problems.append(
                (
                    f"The known-defect entry {entry.id} names {entry.check} on {entry.document}, and no shard ran"
                    f" {entry.check} on {entry.document}, so nothing shows the defect is still there.",
                    (f"corpus:{entry.document}",),
                )
            )
        problems += _on_control(records, entry, "known-defect", entry.document)
    for entry in held_fixed(fixed, readers=readers, selected=selected, ran_controls=ran_controls):
        problems += _on_control(records, entry, "fixed-defect", None)
    return problems


def _on_control(records, entry, register, document):
    """Why an entry is not seen on its control, as ``held_evidence``'s problems: its check never ran there, or its
    symptom no longer shows there (matched as on its own ``document``: a control retains its inputs)."""
    on_control = records.get((entry.check, "control", entry.control))
    if on_control is None:
        return [
            (
                f"The {register} entry {entry.id} retains its control {entry.control}, and no shard ran"
                f" {entry.check} on it, so nothing shows the check still sees the symptom there.",
                (f"control:{entry.control}",),
            )
        ]
    if not any(entry.matches(replace(d, document=document)) for d in on_control):
        return [
            (
                f"The {register} entry {entry.id}'s control {entry.control} no longer shows {entry.check}"
                f" {entry.artifact} {entry.path}{_kind(entry)}.",
                (f"control:{entry.control}",),
            )
        ]
    return []


def verify_evidence(
    directories, entries, *, unsampled=frozenset(), readers=True, selected=None, fixed=(), ran_controls=None
):
    """Why a whole run of the lane does not hold to the registers (decision 12), as person-readable problems.

    Read from the evidence every check wrote (``$PROOF_OUT/checks/<check>/``
    of each block, ``<output>/blocks/<id>/``): every difference on a corpus document falls in a
    registered class with every entry for that document needed
    (``reconcile``), and every entry was seen on its document and on its
    control, which fails when the check never ran on either; every fixed
    entry (``fixed``) was seen on its control. ``unsampled``
    names the corpus documents a run over a sample left out: an entry naming
    one is held on its control alone, and none ran on its document. Without
    ``readers`` (a run that served no state to the readers) the served
    readers' entries, live and fixed, are left out (``held_entries``): no
    check of that run could show one, and the nightly holds them. ``selected``
    names the documents of a run over documents named by hand
    (``proof.store.queue``, ``--documents only:``): every entry is still a
    class their differences may fall in, and only an entry naming one of them
    must have been seen, on it and on its control; the others' documents and
    controls did not run. Such a run holds the fixed entries of the controls
    it ran (``ran_controls``) and leaves the rest.
    """
    found = held_evidence(
        directories,
        entries,
        unsampled=unsampled,
        readers=readers,
        selected=selected,
        fixed=fixed,
        ran_controls=ran_controls,
    )
    return [problem for problem, _ in found]


def main(argv):
    if len(argv) < 2 or argv[0] != "verify":
        print(
            "Usage: python -m proof.checks.registers verify <block directory>... (each block's PROOF_OUT,"
            " <output>/blocks/* of a run)",
            file=sys.stderr,
        )
        return 2
    known = load_known_defects()
    problems = verify_evidence(argv[1:], known, fixed=load_fixed_defects(known=known))
    for problem in problems:
        print(problem, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
