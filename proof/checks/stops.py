"""Where a reader's walk ends short of its end, and the strict list that holds each such stop.

Proofs 3 and 4 compare two states' walks, so a run that ends early on both
sides alike passes with the rest of it unseen. This check reads each walk on
its own: on every baseline state a document's unit serves (A, and proof 4's
B and B-edit, ``proof.observe.served``), each run of Formplayer's walk and of
the Web Apps client's replay of it either reaches its end or is a **stop**,
and every stop is held, by name, in ``proof/walk-stops.json``.

**A run's end.** Formplayer's walk (``proof.formplayer.walk``) ends a run
where the app ends it: a form submitted (``submitted``), a menu that offers
nothing (``empty-menu``), a list that holds no case (``empty-list``). Every
other end is a stop: Formplayer answered with no screen (``notification``),
did not take the form (``submit-refused``), answered a search with the search
screen again (``search-not-run``), was sent no search because the client
keeps it back (``search-refused``), refused a request outright
(``refused``), or the run could not make a choice it was scripted
(``unreplayable``, ``language-unoffered``, ``menu``). The client's replay
(``proof.webapps.observe``) reaches its end where it follows the walk to
the walk's; where it shows nothing to click for a choice, or a form it holds
from going on, its record says where it ``stopped``, and that is a stop.
App Preview shows a form one question a screen, and that way of showing one
ends some forms early (Formplayer answers its Next with an error at a repeat
a worker adds to, and at a form that shows no question); a person there
switches "Use one question per screen" off, so the replay does and the run
goes on with its form shown whole. That is no stop: the run's record keeps
where the one-question form ended (``oneQuestion``), and the check's
evidence lists those runs beside the stops (``replayedWhole``).

**A stop's cause** is a class, written from the reader's own words and never
from a name the app authored where the reader's words do without one
(``said``): what Formplayer said (``notification:unable-to-find-lookup-table``),
the alert the client shows where it stopped (``alert:index-n-out-of-bounds``),
or, with no alert, what the client did not show (``case-not-listed``: no row
for the case the run takes) or held (``form-held``).

**The list** (``walk-stops.json``) holds one entry a document or control and
cause::

    {"document" | "control", "reader", "cause", "reason"}

An entry names where its stop shows by exactly one of two keys: ``document``,
a corpus document, or ``control``, a directory under ``proof/controls/``.
``reader`` is ``formplayer``, ``webapps`` (the client on Web Apps' own page,
a desktop's window and a phone's) or ``preview`` (the client in App Preview,
which shows a form one question a screen); ``reason`` is one line saying why
the walk ends there, which a reviewer can check against the reader's code or
the record. It is strict both ways, as the known-defect register is: a stop
no entry holds fails its document's check and the gate, by name, and so does
an entry whose stop no run of its document showed. An entry is the walk's
real end on the reader, never an answer the lane failed to give: a stop a
worker would get past is the walk's to fix (``proof/README.md``, "Walk
stops").

A ``document`` entry holds the walks of its document and of the control of
the same name, and must show on the document; it need not show on the
control. A ``control`` entry holds that control's walks and no document's,
and must show on the control: a fix that takes a stop off its document moves
the entry to the control that keeps the pre-fix bytes, by changing its key,
and the control's stop stays strict both ways. A ``control`` entry beside the
``document`` entry of the same name, reader and cause would hold one stop
twice, so the list refuses it. A run that hands its states to no reader, or
to some, holds the entries of the readers it observes (``held_entries``) and
leaves the rest to the run with every reader.

Standard library only: the gate reads it with no image.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

PROOF_DIR = Path(__file__).resolve().parents[1]
WALK_STOPS = PROOF_DIR / "walk-stops.json"
# The name the check writes its evidence under (``proof.checks.cases.evidence``).
CHECK = "stops"

FORMPLAYER = "formplayer"
WEBAPPS = "webapps"
PREVIEW = "preview"
READERS = (FORMPLAYER, WEBAPPS, PREVIEW)
# The served reader (``proof.lane.readers.READERS``) whose record shows each: App Preview is the Web Apps client.
OBSERVED_BY = {FORMPLAYER: "formplayer", WEBAPPS: "webapps", PREVIEW: "webapps"}
# What every entry holds, and the two keys of which it holds exactly one: where its stop shows.
SHARED_KEYS = frozenset({"reader", "cause", "reason"})
WHERE_KEYS = ("document", "control")

# The ends of a Formplayer run that are the app's own (``proof.formplayer.walk``): every other is a stop.
ENDS = frozenset({"submitted", "empty-menu", "empty-list"})
# The window a client run's record names (``proof.webapps.observe.shown``) under which App Preview's runs are kept.
PREVIEW_VIEWPORT = "preview"
# What a stopped client run was doing, by the choice of its script it was making (``proof.webapps.observe.plan``).
NOT_SHOWN = {
    "entity": "case-not-listed",
    "menu": "command-not-listed",
    "action": "action-not-offered",
    "search": "search-not-offered",
    "language": "language-not-offered",
}
MAX_CAUSE = 96
# Where a client run's record says it stopped (``stopped.at``, ``proof.webapps.observe``): in its form, else the
# position of the choice it was making; and where it keeps how App Preview's one-question form ended.
IN_FORM = "form"
ONE_QUESTION = "oneQuestion"


class StopsError(ValueError):
    """``walk-stops.json`` is not a list the check can hold every stop to."""


@dataclass(frozen=True)
class Held:
    """One held stop: on ``document`` (a corpus document, and the control of the same name) or on ``control`` (a
    directory under ``proof/controls/``, and no document), exactly one of the two."""

    document: str | None
    reader: str
    cause: str
    reason: str
    control: str | None = None

    @property
    def name(self) -> str:
        """The document or control the entry names."""
        return self.document if self.document is not None else self.control

    @property
    def key(self) -> tuple[str, str, str]:
        return (self.name, self.reader, self.cause)

    def holds(self, name: str, *, control: bool) -> bool:
        """Whether the entry holds the walks of ``name``, a control's where ``control``: a ``document`` entry
        holds its document's and its namesake control's, a ``control`` entry its control's alone."""
        if self.control is not None:
            return control and self.control == name
        return self.document == name

    def shows_on(self, name: str, *, control: bool) -> bool:
        """Whether the entry must show on the walks of ``name``: a ``document`` entry on its document, a
        ``control`` entry on its control."""
        return (self.control if control else self.document) == name


@dataclass(frozen=True)
class Stop:
    """One class of stop a document's walks showed: on ``reader``, for ``cause``, in ``runs`` runs across the
    ``states`` named (``<configuration>/<state>``), with one of them as an ``example``."""

    reader: str
    cause: str
    runs: int
    states: tuple[str, ...]
    example: Mapping

    def as_json(self) -> dict:
        return {
            "reader": self.reader,
            "cause": self.cause,
            "runs": self.runs,
            "states": list(self.states),
            "example": dict(self.example),
        }


# The list ---------------------------------------------------------------------------------------


def stops_path() -> Path:
    """The list a run holds its stops to: ``PROOF_WALK_STOPS`` where the run names one (a harness self-test's
    corpus of its own), else ``proof/walk-stops.json``."""
    named = os.environ.get("PROOF_WALK_STOPS")
    return Path(named) if named else WALK_STOPS


def load(
    path: Path | None = None, *, documents: Iterable[str] | None = None, controls: Iterable[str] | None = None
) -> tuple[Held, ...]:
    """The held stops, each entry checked: its keys (the shared three and exactly one of ``document`` and
    ``control``), its reader, a one-line reason, no two for one name, reader and cause (a ``control`` entry beside
    the ``document`` entry of its name would hold one stop twice), in order (by the name either key holds, then
    reader, then cause), and, with ``documents`` (the corpus's ids) and ``controls`` (the names of the directories
    under ``proof/controls/``), a document the corpus holds and a control directory that exists."""
    path = stops_path() if path is None else path
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise StopsError(f"The walk-stops list {path} does not exist; it holds a list ([] when empty).") from error
    except json.JSONDecodeError as error:
        raise StopsError(f"The walk-stops list {path} is not JSON ({error}).") from error
    if not isinstance(value, list):
        raise StopsError(f"The walk-stops list {path} holds a list of entries.")
    known = None if documents is None else frozenset(documents)
    directories = None if controls is None else frozenset(controls)
    entries, problems, seen = [], [], {}
    for index, raw in enumerate(value):
        where = f"{path.name} entry {index}"
        if not isinstance(raw, dict) or not SHARED_KEYS <= set(raw):
            problems.append(f"{where} holds {sorted(SHARED_KEYS)} and exactly one of {', '.join(WHERE_KEYS)}.")
            continue
        named = [key for key in WHERE_KEYS if key in raw]
        if len(named) != 1 or set(raw) - SHARED_KEYS - set(WHERE_KEYS):
            problems.append(
                f"{where} holds {sorted(SHARED_KEYS)} and exactly one of {', '.join(WHERE_KEYS)}, the document or"
                f" the control its stop shows on; it holds {sorted(raw)}."
            )
            continue
        keys = SHARED_KEYS | set(named)
        if not all(isinstance(raw[key], str) and raw[key] for key in keys):
            problems.append(f"{where}: each of {sorted(keys)} is a non-empty string.")
            continue
        entry = Held(**{"document": None, **raw})
        where = f"{path.name} entry {named[0]} {entry.name} {entry.reader} {entry.cause}"
        if entry.reader not in READERS:
            problems.append(f"{where}: reader is one of {', '.join(READERS)}.")
        if "\n" in entry.reason or entry.reason != entry.reason.strip():
            problems.append(f"{where}: reason is one line, with no space at either end.")
        if entry.key in seen:
            if seen[entry.key] == named[0]:
                problems.append(f"{where}: two entries hold the same stop.")
            else:
                problems.append(
                    f"{where}: the document entry of {entry.name} already holds that stop on the control of its"
                    " name, so the two would hold one stop twice. A stop moves to its control by its entry changing"
                    " its key, never by a second entry."
                )
        seen.setdefault(entry.key, named[0])
        if entry.document is not None and known is not None and entry.document not in known:
            problems.append(f"{where} names a document the corpus does not hold.")
        if entry.control is not None and directories is not None and entry.control not in directories:
            problems.append(f"{where} names a control proof/controls/ holds no directory of.")
        entries.append(entry)
    if [entry.key for entry in entries] != sorted(entry.key for entry in entries):
        problems.append(
            f"{path.name} lists its entries by the document or control each names, then reader, then cause."
        )
    if problems:
        raise StopsError("The walk-stops list is not one the check can hold to:\n  " + "\n  ".join(problems))
    return tuple(entries)


def _field(entry, key: str):
    """One key of an entry, loaded (``Held``) or as the list's file holds it (the queue reads the file unchecked)."""
    return entry.get(key) if isinstance(entry, dict) else getattr(entry, key)


def control_names(entries: Iterable) -> frozenset[str]:
    """The controls the list's ``control`` entries name."""
    return frozenset(name for entry in entries if isinstance(name := _field(entry, "control"), str))


def held_entries(entries: Sequence, *, readers=True) -> tuple:
    """The entries a run holds: those whose reader it observes. ``readers`` is the set of served readers it hands
    its states to (``proof.lane.readers``), true for every one and false for none."""
    if readers is True:
        return tuple(entries)
    observed = frozenset() if readers is False else frozenset(readers)
    return tuple(entry for entry in entries if OBSERVED_BY.get(_field(entry, "reader")) in observed)


# A stop's cause -----------------------------------------------------------------------------------

# A Java exception's class before what it says (``org.commcare...UnresolvedResourceException: ...``).
_JAVA_CLASS = re.compile(r"^(?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error)?:\s*")
# What a reader quotes of the app inside what it says.
_QUOTED = re.compile(r"'[^']*'|\"[^\"]*\"")
# Where what a reader says turns to what the app authored: a colon (but a clock's), a second sentence, a value it
# brackets, and the index, the form, the length or the node it names.
_AUTHORED = re.compile(r"(?<!\d):|:(?!\d)|\.\s|\s[\[\|(]|\sat index\s|\sfor form\s|\sfor length\s|\sfor node\s")
_DIGITS = re.compile(r"-?\d+")
# What a reader says with what the app authored inside the sentence, as the class it is said for: Core's refusal of
# a stored choice a question does not offer (``Selection.java``, ``"value " + xmlValue + " could not be loaded
# into question " + questionText``), and HQ's of a search value that is no date
# (``case_search/xpath_functions/comparison.py``, ``"{value} is not a correctly formatted date or datetime."``).
_SAID_WITH_NAMES = (
    (re.compile(r"^value .* could not be loaded into question "), "value could not be loaded into question"),
    (
        re.compile(r"^\S+ is not a correctly formatted date or datetime"),
        "value is not a correctly formatted date or datetime",
    ),
)
_NOT_WORD = re.compile(r"[^a-z0-9]+")


def said(text) -> str:
    """The class of what a reader said, for a cause: its first line without a Java exception's class and without
    what it quotes, cut where it turns to what the app authored (``_AUTHORED``), each number read as ``n``, as
    lower-case words joined by hyphens. ``nothing`` where it said nothing."""
    line = str(text or "").strip().splitlines()[0] if str(text or "").strip() else ""
    line = _JAVA_CLASS.sub("", line)
    line = next((words for said_so, words in _SAID_WITH_NAMES if said_so.search(line)), line)
    line = _QUOTED.sub("", line)
    cut = _AUTHORED.search(line)
    if cut is not None and cut.start() > 0:
        line = line[: cut.start()]
    words = _NOT_WORD.sub("-", _DIGITS.sub("n", line.lower())).strip("-")
    return (words or "nothing")[:MAX_CAUSE].rstrip("-")


def formplayer_cause(run: Mapping) -> str | None:
    """The cause a run of Formplayer's walk stopped for, or None where it reached its end (``ENDS``)."""
    end = run.get("end")
    if end in ENDS:
        return None
    steps = [step for step in run.get("steps") or () if isinstance(step, dict)]
    last = steps[-1] if steps else {}
    if end == "notification":
        response = last.get("response") if isinstance(last.get("response"), dict) else {}
        notification = response.get("notification") if isinstance(response.get("notification"), dict) else {}
        return f"notification:{said(response.get('exception') or notification.get('message'))}"
    if end == "submit-refused":
        submit = last.get("submit") if isinstance(last.get("submit"), dict) else {}
        notification = submit.get("notification") if isinstance(submit.get("notification"), dict) else {}
        why = notification.get("message") or submit.get("exception") or submit.get("status")
        return f"submit-refused:{said(why)}"
    if end == "refused":
        refused = last.get("refused") if isinstance(last.get("refused"), dict) else {}
        return f"refused:{refused.get('status')}"
    return str(end)


def client_cause(run: Mapping) -> str | None:
    """The cause a run of the client's replay stopped for, or None where it followed the walk to its end: the
    alert the client shows where it stopped, else what it did not show for the choice the run was making
    (``NOT_SHOWN``, by the position its record names, ``stopped.at``), else, in its form, ``form-held`` (it kept
    the worker from going on) or ``form-stopped``."""
    stopped = run.get("stopped")
    if not isinstance(stopped, dict):
        return None
    screen = stopped.get("screen") if isinstance(stopped.get("screen"), dict) else {}
    alerts = [alert for alert in screen.get("alerts") or () if isinstance(alert, str) and alert.strip()]
    if alerts:
        return f"alert:{said(alerts[0])}"
    at = stopped.get("at")
    if at == IN_FORM:
        held = "held" in (run.get("answers") or ()) or run.get("submit") == "held"
        return "form-held" if held else "form-stopped"
    # The choices a worker makes on the app's screens: the places a run gave its form's map are none of them.
    choices = [choice for choice in run.get("script") or () if isinstance(choice, dict) and "places" not in choice]
    if isinstance(at, int) and not isinstance(at, bool) and 0 <= at < len(choices):
        choice = choices[at]
        if "search" in choice and "refused" in (run.get("searches") or ()):
            return "search-refused"
        return next((name for kind, name in NOT_SHOWN.items() if kind in choice), "choice-not-offered")
    return "app-not-opened"


def one_question_cause(run: Mapping) -> str | None:
    """Why App Preview's one-question form did not go on in a run then replayed with its form shown whole (its
    record's ``oneQuestion``, ``proof.webapps.observe.shown``), as ``client_cause`` names a stop; None for a run
    that was not."""
    ended = run.get(ONE_QUESTION)
    return client_cause({**ended, "script": run.get("script")}) if isinstance(ended, dict) else None


def client_reader(run: Mapping) -> str:
    return PREVIEW if run.get("viewport") == PREVIEW_VIEWPORT else WEBAPPS


# A document's stops ------------------------------------------------------------------------------


def served_states(configuration: str, parts: Mapping) -> list[tuple[str, Mapping]]:
    """The baseline served states of one configuration's record parts (``a``, ``b``, ``b_edit``: each the part's
    record or None), as ``(<configuration>/<state>, the state's served record)``: A, where the ``served`` hook
    served it, and proof 4's B and B-edit, where it served them."""
    found = []
    a = ((parts.get("a") or {}).get("hooks") or {}).get("served") or {}
    if a.get("served") and isinstance(a.get("A"), dict):
        found.append((f"{configuration}/A", a["A"]))
    for part, state in (("b", "B"), ("b_edit", "B-edit")):
        held = ((parts.get(part) or {}).get("proof4") or {}).get("served") or {}
        if held.get("served"):
            found.append((f"{configuration}/{state}", held))
    return found


def state_stops(state: str, trace: Mapping | None, screens: Mapping | None) -> list[dict]:
    """Each stopped run of one served state: Formplayer's (from its ``trace``) and the client's (from its
    ``screens`` record), as ``{"reader", "cause", "state", "script", ...}`` with what the reader showed there."""
    found = []
    for run in (trace or {}).get("runs") or ():
        cause = formplayer_cause(run) if isinstance(run, dict) else None
        if cause is not None:
            found.append({"reader": FORMPLAYER, "cause": cause, "state": state, "script": run.get("script")})
    for run in (screens or {}).get("runs") or ():
        cause = client_cause(run) if isinstance(run, dict) else None
        if cause is None:
            continue
        screen = (run["stopped"].get("screen") or {}) if isinstance(run["stopped"].get("screen"), dict) else {}
        found.append(
            {
                "reader": client_reader(run),
                "cause": cause,
                "state": state,
                "script": run.get("script"),
                "viewport": run.get("viewport") or "desktop",
                "breadcrumbs": screen.get("breadcrumbs"),
                "alerts": screen.get("alerts"),
            }
        )
    return found


def state_whole(state: str, screens: Mapping | None) -> list[dict]:
    """Each run of one served state that App Preview's one-question form did not carry to its end and the
    replay then showed whole (``one_question_cause``), as ``state_stops`` gives a stop: no stop, since the run
    went on as a person there goes on, and kept with the stops so a reader sees which forms that mode ends."""
    found = []
    for run in (screens or {}).get("runs") or ():
        cause = one_question_cause(run) if isinstance(run, dict) else None
        if cause is not None:
            ended = run[ONE_QUESTION].get("stopped") or {}
            screen = ended.get("screen") if isinstance(ended.get("screen"), dict) else {}
            found.append(
                {
                    "reader": PREVIEW,
                    "cause": cause,
                    "state": state,
                    "script": run.get("script"),
                    "breadcrumbs": screen.get("breadcrumbs"),
                    "alerts": screen.get("alerts"),
                }
            )
    return found


def classed(stopped: Iterable[Mapping]) -> list[Stop]:
    """Stopped runs as one ``Stop`` a reader and cause, in order."""
    by: dict[tuple[str, str], list[Mapping]] = {}
    for stop in stopped:
        by.setdefault((stop["reader"], stop["cause"]), []).append(stop)
    return [
        Stop(
            reader=reader,
            cause=cause,
            runs=len(runs),
            states=tuple(sorted({run["state"] for run in runs})),
            example={key: value for key, value in runs[0].items() if key not in ("reader", "cause")},
        )
        for (reader, cause), runs in sorted(by.items())
    ]


# Holding them -----------------------------------------------------------------------------------


def unheld(name: str, shown: Iterable[tuple[str, str]], entries: Sequence[Held], *, control=False) -> list[str]:
    """Why the stops of a document's walks, or a control's where ``control`` (each a reader and a cause), are not
    all held, one line each. A control's are held by the ``control`` entries of its name and by the ``document``
    entries of its name; a document's by its ``document`` entries alone."""
    held = {(entry.reader, entry.cause) for entry in entries if entry.holds(name, control=control)}
    adding = "an entry naming the control" if control else "the entry"
    return [
        f"{name}: a run of {_who(reader)} stops for {cause}, and proof/walk-stops.json holds no such stop."
        " Read the run (the check's evidence names one): where a worker would get past it, the walk or the replay"
        f" is to give what a worker gives; where the reader itself ends there, add {adding} with its reason."
        for reader, cause in sorted(set(shown))
        if (reader, cause) not in held
    ]


def unshown(name: str, shown: Iterable[tuple[str, str]], entries: Sequence[Held], *, control=False) -> list[str]:
    """Why the entries that must show on a document's walks, or a control's where ``control``, are not all shown by
    its stops, one line each: a ``document`` entry on its document, a ``control`` entry on its control."""
    seen = set(shown)
    what = "control" if control else "document"
    return [
        f"{name}: proof/walk-stops.json holds a stop of {_who(entry.reader)} for {entry.cause}, and no run of"
        f" the {what} stops so now. Remove the entry."
        for entry in entries
        if entry.shows_on(name, control=control) and (entry.reader, entry.cause) not in seen
    ]


def _who(reader: str) -> str:
    return {
        FORMPLAYER: "Formplayer's walk",
        WEBAPPS: "the Web Apps client",
        PREVIEW: "the Web Apps client in App Preview",
    }[reader]


def _evidence(directories) -> dict[tuple[str, str], list[tuple[str, str]]]:
    """Each document's stops as the check wrote them (``$PROOF_OUT/checks/stops/``), by (kind, id): each a
    reader and a cause."""
    records: dict[tuple[str, str], list[tuple[str, str]]] = {}
    for directory in directories:
        for path in sorted(Path(directory, "checks", CHECK).glob("*.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            records.setdefault((record["kind"], record["document"]), []).extend(
                (stop["reader"], stop["cause"]) for stop in record.get("stops") or ()
            )
    return records


def held_evidence(
    directories, entries: Sequence[Held], *, unrun=frozenset(), unrun_controls=frozenset(), readers=True
) -> list[tuple[str, tuple[str, ...]]]:
    """Why a whole run of the lane does not hold to the walk-stops list, as person-readable problems, each with
    the lane's group a rerun of which shows it again (``corpus:<id>`` or ``control:<id>``): a stop a document or a
    control showed that no entry holds, and an entry whose stop its document's or control's run did not show, or
    whose document's or control's check never ran. ``unrun`` names the corpus documents the run did not run (left
    out of its sample or its selection) and ``unrun_controls`` the controls a selection did not queue, whose
    entries are held by the run that runs them; ``readers`` is as ``held_entries`` takes it."""
    entries = held_entries(entries, readers=readers)
    records = _evidence(directories)
    problems: list[tuple[str, tuple[str, ...]]] = []
    for (kind, name), shown in sorted(records.items()):
        problems += [
            (problem, (f"{kind}:{name}",)) for problem in unheld(name, shown, entries, control=kind == "control")
        ]
    must = sorted(
        {("corpus", entry.document) for entry in entries if entry.document is not None and entry.document not in unrun}
        | {
            ("control", entry.control)
            for entry in entries
            if entry.control is not None and entry.control not in unrun_controls
        }
    )
    for kind, name in must:
        shown = records.get((kind, name))
        if shown is None:
            what = "stops of this control" if kind == "control" else "its stops"
            problems.append(
                (
                    f"{name}: proof/walk-stops.json holds {what}, and no shard ran the stops check on it, so"
                    " nothing shows its walks still end there.",
                    (f"{kind}:{name}",),
                )
            )
            continue
        problems += [
            (problem, (f"{kind}:{name}",)) for problem in unshown(name, shown, entries, control=kind == "control")
        ]
    return problems


def verify_evidence(
    directories, entries: Sequence[Held], *, unrun=frozenset(), unrun_controls=frozenset(), readers=True
) -> list[str]:
    """``held_evidence``'s problems alone."""
    found = held_evidence(directories, entries, unrun=unrun, unrun_controls=unrun_controls, readers=readers)
    return [problem for problem, _ in found]
