"""The changes Nova tells a person its publish makes in CommCare HQ, as the lane reads them
(``proof/first-publish-changes.json``, the first-publish register), and their judge.

Some of what Nova's publish over an app it reads from CommCare HQ changes there
is on purpose, and Nova says which before it sends anything
(``lib/deployment/reading/firstPublishChanges.ts::FIRST_PUBLISH_CHANGES``, the
typed register). A shard holds no TypeScript, so the lane keeps this file
beside it: one object a change, in the register's order, each with the kinds of
place the change stands at and the rows of the differences it allows, in the
lane's own vocabulary::

    {"change": "case-names-checked",
     "placeKinds": ["form-node", "form-part", "form", "case"],
     "rows": [{"check": "source", "artifact": "app.json", "path": "/modules/*/forms/*/actions"}]}

- A ``source`` row is one of the entry's paths in the typed register: a JSON
  Pointer over HQ's stored app, ``*`` for a position or an app's own key, that
  covers everything under it. It matches a ``source`` difference
  (``proof.checks.source``) whose concrete pointer (``at``) or structural path
  it covers.
- A ``proof1``, ``proof2`` or ``proof3`` row names a class as a known-defect
  entry does (``proof.checks.registers``): the check, the artifact (``*`` any
  run of characters), the exact structural path and, where it names one, the
  kind. Such a row is written from a document's own evidence (``rows``,
  below), never by typing a path.

A row names what a change may change; a place names where. On a document made
in HQ, ``first-publish.json`` lists each change the reading says the first
publish makes with the places it stands at on this app
(``firstPublishChanges.ts::firstPublishChangePlaces``,
``lib/deployment/reading/firstPublishPlaces.ts``): JSON Pointers over one tree
of the app by position (``/app/<key>``, ``/menu/<m>/<key>``,
``/form/<m>.<f>/<key>``, a form's XForm under ``/form/<m>.<f>/xform``, its
data nodes at ``xform/data/...``, ``/case/<type>/<property>``), ``**`` in a
place any run of steps. One change alone, ``forms-and-settings-rewritten``,
stands everywhere (``placeKinds`` ``["app-wide"]``, its place the empty
pointer); every other entry declares the kinds of place it stands at, and the
loader refuses an entry that declares none of its own, so each change can be
seen apart from the one that stands everywhere. Nor may the one that stands
everywhere name a form's whole source (``/_attachments/*``): its rows name the
part classes of a form Nova's own spelling changes, written from a run's
evidence (``rows`` below), so a change of a question no change makes reaches
the registers.

Each difference has a location in the same tree (``locate``): a source
difference by its pointer (a form's XForm by the part and the node
``proof.checks.xform_parts`` names), proof 1's by the form and question or the
case type and property it names, proof 2's and proof 3's by what the
document's records say of where each stands (``Sites``, written beside the
``changes`` check's evidence): a build element by the id of CommCare's own
vocabulary its pointer carries (a menu's ``m<m>``, a detail's
``m<m>_case_short``, a command's ``m<m>-f<f>``, an app string's key, each
holding positions) or, where it names an element only by position, by what
the build holds there (a suite entry's command); a session's step by the form
or the menu its run's script opened, a submission's or an event's node in
that form, a menu's choice at the menu or form it opens, a case at its type.
A difference no record places stands nowhere (``NOWHERE``), where only the
change that stands everywhere stands. A text HQ's build writes from two names
stands at both (``locations``: a form's suite descriptor at its form's name and
its menu's). A change holds a difference where a row
of it names the difference's class and one of its places lies at the
difference's location or above it; the most exact such place (the most steps
it matches the location by name) is the one that holds it, so
``forms-and-settings-rewritten`` keeps exactly what no other applying change's
place holds, and two changes whose places are equally exact both hold it.

An entry applies in two places, and on no other document and no control:

- on a document made in HQ, where its ``first-publish.json`` lists it;
- on a document whose saves in CommCare HQ Nova brings in (``hq-side.json``
  states the republish ``brings-in``), where Nova's review of those saves
  lists it for the next publish (the statement's ``publishChanges``, which the
  capture holds to the review's own list,
  ``proof/corpus/publish.ts::bringInOverPeer``). Unshown form media stands at
  the current reading's exact places recorded by that capture. Other changes
  stand everywhere and hold by their rows.

A document made in HQ states no saves (``proof/corpus/entryWriter.ts`` refuses
both), so a document has one list or none. The judge is strict both ways
(``differences``): a difference no applying entry holds is held to the
spelling rules and the known-defect register like any other, by the check that
reports it, and it is also ``/<id>/unsaid`` once, of the one entry that names
it as a change of its own where that entry does not apply (``naming``: of the
rows that match it and that no other entry holds too, the most exact are that
entry's alone), so a class many entries share (every form's whole source)
names no one; an applying entry that holds no difference, or none it holds
more exactly than every other applying change, is ``/<id>/unseen``.

A difference at a place the stored-app comparison holds Nova to keep
(``HELD_PATHS``: a media path the document holds, the property a case list
column shows) is never a declared change: no row matches it, however wide,
the inert allowance does not hold it, and the register refuses a row that
names one (``held``).

The inert allowance: ``forms-and-settings-rewritten`` also holds a ``source``
difference under a place the reader's claim log holds under an entry of
standing inert (``ClaimPlaces``, from ``parity.claim_places_of``), but not
where the log holds a record of another standing at or below that inert place
on the difference's own branch: the log records some claims at the container
whose value they read (a key of a language's strings at ``/translations``, a
profile key HQ's settings do not list at ``/profile``), and where a kept or
held claim shares that place the log does not tell which key under it is the
inert one.

The ``changes`` check writes beside its differences everything the judge read
(``evidence``: the applying changes with their places, the claim places, the
sites, the served readers the run observes, every difference of each check it
was handed), so over a lane run's output, or a directory holding a sharded
run's outputs, one a shard,

    python3 -m proof.checks.changes rows <output> <document>

prints, for each difference that no applying change holds, the row that names
its class and the changes whose places stand there most exactly, the change a
person writes the row under where its change shows there, and

    python3 -m proof.checks.changes replay <output> <document>

makes the judgment again with this tree's register and judge (``replayed``):
the differences held, those left undeclared, the unsaid and the unseen.

Standard library only (``proof/CLAUDE.md``, "What runs with no image").
"""

from __future__ import annotations

import fnmatch
import json
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from proof.checks.differences import KINDS, Difference, artifact_reader, served_artifact

PROOF_DIR = Path(__file__).resolve().parents[1]
FIRST_PUBLISH_CHANGES = PROOF_DIR / "first-publish-changes.json"
ROW_CHECKS = ("source", "proof1", "proof2", "proof3")
# The entry whose source rows also cover every pointer the claim log holds under an entry of standing ``inert``:
# Nova writes every form and setting in its own spelling, the settings no runtime reads among them.
INERT_ALLOWANCE = "forms-and-settings-rewritten"
# The step the stored-app comparison (``proof.checks.source``) writes where it compares what Nova holds the first
# publish to keep, and the two structural paths it reports there (``*`` one step of any name): a media path the
# document holds (its map item's ids and its resource's version) and the property a case list column shows.
HELD = "held"
HELD_PATHS = (f"/multimedia_map/*/{HELD}", f"/modules/*/case_details/*/columns/*/{HELD}")
CHANGE_KEYS = frozenset({"change", "placeKinds", "rows"})
ROW_KEYS = frozenset({"check", "artifact", "path"})
OPTIONAL_ROW_KEYS = frozenset({"kind"})
OWNED_PROFILE_SETTINGS = ("/profile/properties/cc-show-saved", "/profile/properties/cc-show-incomplete")
CASE_SCALAR_TRIM = "".join(chr(unit) for unit in range(0x21))
UNSHOWN_MEDIA = "unshown-form-media-removed"
# The kinds of place (``lib/deployment/reading/firstPublishPlaces.ts::FIRST_PUBLISH_PLACE_KINDS``).
APP_WIDE = "app-wide"
PLACE_KINDS = frozenset({APP_WIDE, "app", "menu", "form", "form-node", "form-part", "case"})
# In a place, any run of steps; in a location, anything below the step before it (``BELOW``).
ANY_RUN = "**"
BELOW = "**"
EVERYWHERE = ("",)


class ChangesError(ValueError):
    """``proof/first-publish-changes.json``, or a document's ``first-publish.json``, is not one the judge can hold
    differences to."""


@dataclass(frozen=True)
class Row:
    check: str  # "source", "proof1", "proof2" or "proof3"
    artifact: str
    path: str
    kind: str | None = None

    def matches(self, difference) -> bool:
        if held(difference):
            return False
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
    kinds: tuple[str, ...] = (APP_WIDE,)

    @property
    def app_wide(self) -> bool:
        return self.kinds == (APP_WIDE,)

    def matches_value(self, difference) -> bool:
        """The value a row permits where its path and kind alone cannot distinguish the declared change."""
        if self.change in {"web-apps-turned-on", "web-apps-turned-off"} and difference.at in {
            "/cloudcare_enabled",
            "/home/releaseListed",
        }:
            enabled = self.change == "web-apps-turned-on"
            return difference.kind == "changed" and difference.before is (not enabled) and difference.after is enabled
        if (
            self.change in {"forms-and-settings-rewritten", "incomplete-forms-tile-hidden"}
            and difference.check == "source"
            and any(covers(path, difference.path) for path in OWNED_PROFILE_SETTINGS)
        ):
            return difference.at in OWNED_PROFILE_SETTINGS and difference.kind == "added" and difference.after == "no"
        # Formplayer's Java String.trim removes boundary U+0000 through U+0020 (caseScalarTextValueCalculation).
        if (
            self.change == "case-names-checked"
            and difference.artifact.startswith("formplayer@")
            and difference.kind == "changed"
            and difference.path.endswith("/case_name[*]/text()")
        ):
            return trimmed_case_name(difference.before, difference.after)
        return True


def trimmed_case_name(before, after):
    """The nonempty, bounded name Nova accepts after Java String.trim removes its end characters."""
    return (
        isinstance(before, str)
        and isinstance(after, str)
        and after == before.strip(CASE_SCALAR_TRIM)
        and 0 < len(after.encode("utf-16-le", errors="surrogatepass")) <= 510
    )


def tokens(pointer: str) -> list[str]:
    if pointer == "" or pointer == "/":
        return []
    if not pointer.startswith("/"):
        raise ChangesError(f"{pointer!r} is no JSON Pointer: a pointer starts with /.")
    return pointer[1:].split("/")


def unescaped(pointer: str) -> list[str]:
    """``pointer``'s tokens, each a JSON Pointer token unescaped."""
    return [token.replace("~1", "/").replace("~0", "~") for token in tokens(pointer)]


def covers(pattern: str, pointer: str) -> bool:
    """Whether a source row's pointer (``*`` one step of any name) covers ``pointer``: equal to it, or above it."""
    wanted, found = tokens(pattern), tokens(pointer)
    return len(wanted) <= len(found) and all(step in ("*", got) for step, got in zip(wanted, found, strict=False))


def _shaped(pattern: str, path: str) -> bool:
    """Whether ``path`` is ``pattern`` exactly, ``*`` in the pattern one step of any name."""
    wanted, found = tokens(pattern), tokens(path)
    return len(wanted) == len(found) and all(step in ("*", got) for step, got in zip(wanted, found, strict=True))


def held(difference) -> bool:
    """Whether ``difference`` is the stored-app comparison's at a place Nova holds the first publish to keep
    (``HELD_PATHS``), which no first-publish entry declares."""
    return difference.check == "source" and any(_shaped(pattern, difference.path) for pattern in HELD_PATHS)


def _within(above: str, below: str) -> bool:
    """Whether the JSON Pointer ``below`` is ``above`` or under it, step for step (no step is a wildcard)."""
    upper, lower = tokens(above), tokens(below)
    return len(upper) <= len(lower) and lower[: len(upper)] == upper


# Places and locations ----------------------------------------------------------------


def place_kind(place: str) -> str | None:
    """The kind of ``place`` (``firstPublishPlaces.ts::firstPublishPlaceKind``), or None for none the vocabulary
    holds."""
    if place == "":
        return APP_WIDE
    if not place.startswith("/"):
        return None
    steps = unescaped(place)
    root = steps[0]
    if root == "app":
        return "app"
    if root == "menu":
        return "menu" if len(steps) > 1 and steps[1].isdigit() else None
    if root == "case":
        return "case" if len(steps) > 1 else None
    if root == "form":
        if len(steps) < 2 or not _position(steps[1]):
            return None
        if len(steps) < 3 or steps[2] != "xform":
            return "form"
        return "form-node" if len(steps) > 3 and steps[3] == "data" else "form-part"
    return None


def _position(token: str) -> bool:
    menu, dot, form = token.partition(".")
    return bool(dot) and menu.isdigit() and form.isdigit()


def _app_location(steps: list[str]) -> tuple[str, ...]:
    """Where a pointer over HQ's stored app stands in the tree places name: a form's attachment, keyed by its
    position (``form:<m>.<f>.xml``), as its XForm; a form's key and a menu's by position; any other key the app's."""
    if len(steps) >= 2 and steps[0] == "_attachments":
        name = steps[1]
        if name.startswith("form:") and name.endswith(".xml") and _position(name[5:-4]):
            return ("form", name[5:-4], "xform", *steps[2:])
        return ("app", *steps)
    if len(steps) >= 2 and steps[0] == "modules" and steps[1].isdigit():
        if len(steps) >= 4 and steps[2] == "forms" and steps[3].isdigit():
            return ("form", f"{steps[1]}.{steps[3]}", *steps[4:])
        return ("menu", *steps[1:])
    return ("app", *steps)


def _without_position(step: str) -> str:
    """An XML step of a trace's location (``name[2]``, ``case[@case_id=x]``) as the element's name alone."""
    return step.split("[", 1)[0]


def _elements(steps) -> list[str]:
    """The element steps of an XML location, each by its name, up to its first step that is no element
    (``text()``, ``@name``, ``order()``)."""
    found = []
    for step in steps:
        if step.startswith("@") or step.endswith("()"):
            break
        found.append(_without_position(step))
    return found


# Where the lane's records say a run, a step of it, a case or a part of a build stands ------------------------


@dataclass(frozen=True)
class Sites:
    """What the records of one document say of where a difference proofs 2 and 3 report stands, which its own
    pointer cannot say (``proof.checks.proof2.document_sites``, ``proof.checks.proof3.document_sites``): each
    value a location prefix (``locate``), or None where two configurations or two sides say two places.

    - ``runs``: each session run of proof 3 (its index in the trace) by what it ends at: the form its script
      opens, else the menu it ends in;
    - ``steps``: each step of a run, ``(run, step)``, by where the step stands: a form's step at the form, a case
      list's at the menu's detail, a search's at the menu's search, a menu's at the menu;
    - ``choices``: each choice a menu step shows, ``(run, step, choice)``, by the menu or form it opens;
    - ``cases``: each case's type by its id, as a difference writes the id (a generated id by its label);
    - ``builds``: an element of a build file a difference names only by its position, ``(artifact, step)``
      (``("suite.xml", "entry[7]")``), by the menu or form it is of, and an app string whose key does not say
      what it is of, ``("app_strings", key)`` in every language's file, by where it stands (a sort-only
      element's header, whose key's number is its order among the sort elements and no column's);
    - ``served``: a concrete (artifact, observation pointer) in a submitted repeat's case-name writer or a served
      reader, located by its own navigation,
      submitted instance, or question binding on the side that produced it;
    - ``media``: each media resource of a built media suite by the media path it installs (``jr://file/...``).
    """

    runs: Mapping = field(default_factory=dict)
    steps: Mapping = field(default_factory=dict)
    choices: Mapping = field(default_factory=dict)
    cases: Mapping = field(default_factory=dict)
    builds: Mapping = field(default_factory=dict)
    media: Mapping = field(default_factory=dict)
    served: Mapping = field(default_factory=dict)

    def as_json(self):
        """The sites as the ``changes`` check's evidence writes them, each map a list of ``[key, value]``
        (``from_json`` reads them back)."""

        def written(value):
            return list(value) if isinstance(value, tuple) else value

        return {
            name: sorted(([written(key), written(value)] for key, value in getattr(self, name).items()), key=json.dumps)
            for name in SITE_MAPS
        }

    @classmethod
    def from_json(cls, value):
        def read(held):
            return tuple(held) if isinstance(held, list) else held

        value = value if isinstance(value, dict) else {}
        return cls(**{name: {read(key): read(held) for key, held in value.get(name) or ()} for name in SITE_MAPS})


SITE_MAPS = ("runs", "steps", "choices", "cases", "builds", "media", "served")
NO_SITES = Sites()


def merged_sites(*all_sites: Sites) -> Sites:
    """The sites of several configurations, sides or checks as one: a key two of them give two values holds
    None, which ``locate`` reads as a place no change but the one that stands everywhere stands at."""
    found = {name: {} for name in SITE_MAPS}
    for sites in all_sites:
        for name in SITE_MAPS:
            held = found[name]
            for key, value in getattr(sites, name).items():
                if key in held and held[key] != value:
                    held[key] = None
                else:
                    held.setdefault(key, value)
    return Sites(**found)


# A location no place but the whole app's stands at: what a difference names no place of, or a place two
# configurations or two sides of the records name apart.
NOWHERE = ()


def _site(mapping, key) -> tuple[str, ...]:
    held = mapping.get(key)
    return NOWHERE if held is None else tuple(held)


def _run_step(steps) -> tuple[int, int] | None:
    if len(steps) >= 4 and steps[0] == "runs" and steps[2] == "trace" and steps[1].isdigit() and steps[3].isdigit():
        return int(steps[1]), int(steps[3])
    return None


def _trace_location(difference, sites: Sites) -> tuple[str, ...]:
    """A proof 3 difference's location: a step's by where the step stands (``Sites.steps``), its submission's and
    events' nodes in the step's form, a menu's choice at the menu or form it opens, a case of the case
    database at its type, and anything else of a step under the step's place."""
    steps = unescaped(difference.at)
    artifact = difference.artifact
    if artifact.startswith(("trace@", "case_blocks@")) and difference.path.endswith(":trimmed"):
        return _site(sites.served, (artifact, difference.at))
    if artifact == "webapps@B" and difference.at == "/home/releaseListed":
        return ("app", "cloudcare_enabled")
    if artifact == "webapps@B" and difference.at == "/home/tiles/incomplete":
        return ("app", "profile", "properties", "cc-show-incomplete")
    if artifact.startswith(("formplayer@", "webapps@", "android@", "android-tablet@", "connect@")):
        owner = _site(sites.served, (artifact, difference.at))
        # The saved device case is attributed to its type and property only once the form that
        # actually wrote it has also agreed across both readers' records and all configurations.
        if owner[:1] == ("form",) and owner[2:3] == ("case",):
            return owner[2:]
        return owner
    if artifact.startswith("trace@"):
        at = _run_step(steps)
        if at is None:
            if len(steps) >= 3 and steps[0] == "runs" and steps[1].isdigit():
                place = _site(sites.runs, int(steps[1]))
                return (*place, BELOW) if place else NOWHERE
            return NOWHERE
        place = _site(sites.steps, at)
        if len(steps) < 5:
            return (*place, BELOW) if place else NOWHERE
        field_, rest = steps[4], steps[5:]
        if field_ == "caseDb":
            # ``casedb``, then the case by its id, then the property, read from the XML path as the comparison
            # wrote it (an id may hold a ``/``).
            elements = _xml_steps(_xml_remainder(difference.at))
            if len(elements) >= 2 and elements[1].startswith("case[@case_id="):
                kind = _site(sites.cases, _identity(elements[1], "[@case_id="))
                if not kind:
                    return NOWHERE
                return ("case", *kind, *_elements(elements[2:])) if len(elements) > 2 else ("case", *kind, BELOW)
            return NOWHERE
        if field_ == "choices" and rest and rest[0].isdigit():
            opened = _site(sites.choices, (*at, int(rest[0])))
            if not opened:
                return NOWHERE
            what = rest[1] if len(rest) > 1 else None
            return (*opened, CHOICE_FIELDS.get(what, BELOW))
        if not place:
            return NOWHERE
        if place[0] == "form":
            if field_ == "submission":
                return (*place, "xform", *_elements(_xml_steps(_xml_remainder(difference.at))))
            if field_ == "events" and rest:
                key = rest[0].split("#", 1)[0]
                _, colon, path = key.partition(":")
                if colon:
                    return (*place, "xform", *[_without_position(step) for step in path.split("/") if step])
                return (*place, "xform", BELOW)
            if field_ == "title":
                return (*place, "xform", "title")
        return (*place, BELOW)
    if artifact.startswith("case_blocks@") and len(steps) >= 3 and steps[0] == "runs" and steps[1].isdigit():
        run = int(steps[1])
        if steps[2] == "blocks" and len(steps) >= 5:
            form = _site(sites.runs, run)
            if not form or form[0] != "form":
                return NOWHERE
            block = [step for step in steps[4].split("/") if step]
            under = [step for step in steps[5:] if not step.isdigit()]
            return (*form, "xform", "data", *block, *under)
        if steps[2] == "cases" and len(steps) >= 4:
            kind = _site(sites.cases, steps[3])
            if not kind:
                return NOWHERE
            field_ = steps[4:]
            if field_ and field_[0] == "properties":
                field_ = field_[1:]
            return ("case", *kind, *_relation_steps(field_)) if field_ else ("case", *kind, BELOW)
        form = _site(sites.runs, run)
        return (*form, BELOW) if form else NOWHERE
    return NOWHERE


def _xml_remainder(at: str) -> str:
    """What follows ``/runs/<run>/trace/<step>/<field>`` in a pointer: an XML path the comparison appended as it
    is (``compare.trace``), never escaped as a pointer."""
    parts = at.split("/", 6)
    return parts[6] if len(parts) > 6 else ""


# What a menu step's choice shows (``SessionOp.java``): its text, the name of the menu or form it opens; its image
# and audio, that menu's or form's media.
CHOICE_FIELDS = {"text": "name", "image": "media_image", "audio": "media_audio"}


def _relation_steps(steps) -> list[str]:
    """A case property's steps, a property read through a relation (``parent/name``) as its relation's steps."""
    return [part for step in steps for part in step.split("/") if part]


def _xml_steps(at: str) -> list[str]:
    """An XML location's steps, a ``/`` inside a step's brackets (an identity's value) kept in its step."""
    found, depth, current = [], 0, []
    for character in at:
        if character == "[":
            depth += 1
        elif character == "]":
            depth -= 1
        if character == "/" and depth == 0:
            found.append("".join(current))
            current = []
        else:
            current.append(character)
    found.append("".join(current))
    return [step for step in found if step]


def _identity(step: str, prefix: str = "[@id=") -> str | None:
    """The value a step of an XML location names its element by, after ``prefix`` (``menu[@id=m3]`` gives
    ``m3``; ``media[resource/@id=x]`` with ``[resource/@id=`` gives ``x``), or None."""
    start = step.find(prefix)
    if start < 0 or not step.endswith("]"):
        return None
    return step[start + len(prefix) : step.index("]", start)]


def command_place(command: str | None) -> tuple[str, ...]:
    """Where a suite command of CommCare HQ's build stands: a form's, ``m<m>-f<f>`` (``id_strings.form_command``),
    at the form; a menu's, ``m<m>`` (``menu_id``), its case list's, ``m<m>-case-list``, and its search's,
    ``search_command.m<m>``, at the menu; any other at no place."""
    if not command:
        return NOWHERE
    if command.startswith("search_command.m") and command[len("search_command.m") :].isdigit():
        return ("menu", command[len("search_command.m") :])
    if not command.startswith("m"):
        return NOWHERE
    menu, dash, rest = command[1:].partition("-")
    if not menu.isdigit():
        return NOWHERE
    if not dash:
        return ("menu", menu)
    if rest == "case-list":
        return ("menu", menu)
    if rest.startswith("f") and rest[1:].isdigit():
        return ("form", f"{menu}.{rest[1:]}")
    return NOWHERE


def detail_place(detail: str | None) -> tuple[str, ...]:
    """Where a detail of CommCare HQ's build stands, ``m<m>_<type>`` (``id_strings.detail``): a case list's short
    or long detail at the menu's, any other detail of the menu at its details."""
    if not detail or not detail.startswith("m"):
        return NOWHERE
    menu, _, kind = detail[1:].partition("_")
    if not menu.isdigit():
        return NOWHERE
    return ("menu", menu, "case_details", *DETAIL_KINDS.get(kind, ()))


DETAIL_KINDS = {"case_short": ("short",), "case_long": ("long",)}


def _suite_location(artifact: str, steps: list[str], sites: Sites) -> tuple[str, ...]:
    if len(steps) < 2 or steps[0] != "suite":
        return NOWHERE
    top = steps[1]
    name = _without_position(top)
    rest = steps[2:]
    if name == "menu":
        # A menu's text and display are its name and its media together (a picture taken away writes its
        # name as text), so they stand at the menu.
        menu = command_place(_identity(top))
        return (*menu, BELOW) if menu else NOWHERE
    if name == "detail":
        detail = detail_place(_identity(top))
        return (*detail, BELOW) if detail else NOWHERE
    if name == "xform":
        form = _site(sites.builds, (artifact, top))
        return (*form, "name") if form else NOWHERE
    if name in ("entry", "remote-request"):
        command = next((_identity(step) for step in rest if _without_position(step) == "command"), None)
        owner = command_place(command) if command is not None else _site(sites.builds, (artifact, top))
        if not owner:
            return NOWHERE
        child = _without_position(rest[0]) if rest else None
        if name == "remote-request":
            return (owner[0], owner[1], "search_config", BELOW) if owner[0] == "menu" else NOWHERE
        if child == "session" and len(rest) > 1:
            part = _without_position(rest[1])
            if part == "datum":
                menu = owner[1].split(".")[0]
                return (
                    ("menu", menu, "case_details", "short", "filter")
                    if rest[-1] == "@nodeset"
                    else ("menu", menu, "case_details", BELOW)
                )
            if part == "query":
                return ("menu", owner[1].split(".")[0], "search_config", BELOW)
        if child == "stack" and owner[0] == "form":
            return (*owner, "form_links", BELOW)
        return (*owner, BELOW)
    return NOWHERE


def _app_strings_location(key: str) -> tuple[str, ...]:
    """Where an app string of CommCare HQ's build stands, by the key HQ writes it under (``id_strings``): a
    menu's or a form's name and media, a case list item's or Register button's label, a detail's column or
    texts, a search's texts; the app's name; nothing else."""
    if key in APP_NAME_KEYS:
        return ("app", "name")
    parts = key.split(".")
    head = parts[0]
    if head == "modules" and len(parts) >= 2 and parts[1][1:].isdigit() and parts[1].startswith("m"):
        menu = parts[1][1:]
        return ("menu", menu, *MEDIA_SUFFIXES.get(tuple(parts[2:]), ("name",) if len(parts) == 2 else (BELOW,)))
    if head == "forms" and len(parts) >= 2 and parts[1].startswith("m"):
        menu, f, form = parts[1][1:].partition("f")
        if menu.isdigit() and f and form.isdigit():
            place = ("form", f"{menu}.{form}")
            return (*place, *MEDIA_SUFFIXES.get(tuple(parts[2:]), ("name",) if len(parts) == 2 else (BELOW,)))
        return NOWHERE
    if head in ("case_lists", "case_list_form") and len(parts) >= 2 and parts[1][1:].isdigit():
        menu, slot = parts[1][1:], "case_list" if head == "case_lists" else "case_list_form"
        if len(parts) == 2:
            return ("menu", menu, slot, "label")
        return ("menu", menu, slot, BELOW)
    if head in ("case_search", "case_search_again", "search_command", "search_property") and len(parts) >= 2:
        menu = parts[1][1:]
        return ("menu", menu, "search_config", BELOW) if parts[1].startswith("m") and menu.isdigit() else NOWHERE
    if head.startswith("m") and head.endswith(("_no_items_text", "_select_text")):
        menu, _, text = head[1:].partition("_")
        if menu.isdigit():
            return ("menu", menu, "case_details", "short", text)
        return NOWHERE
    if head.startswith("m") and head[1:].isdigit() and len(parts) >= 2:
        detail = ("menu", head[1:], "case_details", *DETAIL_KINDS.get(parts[1], ()))
        if len(detail) == 3 or len(parts) < 3:
            return (*detail, BELOW)
        column = parts[2].rpartition("_")[2]
        if column.isdigit() and int(column) >= 1:
            return (*detail, "columns", str(int(column) - 1), *(("header",) if parts[3:] == ["header"] else (BELOW,)))
        return (*detail, BELOW)
    return NOWHERE


MEDIA_SUFFIXES = {("icon",): ("media_image",), ("audio",): ("media_audio",)}
# The app strings CommCare HQ's build writes from the app's name (``app_strings.py::_create_custom_app_strings``).
APP_NAME_KEYS = frozenset({"app.display.name", "homescreen.title"})
# The artifact ``Sites.builds`` keys an app string under, in every language's file alike.
APP_STRINGS = "app_strings"


def _build_location(difference, sites: Sites) -> tuple[str, ...]:
    """A proof 2 difference's location, by the ids of its build's own vocabulary its pointer carries (a menu's,
    a detail's, a command's: each holds the menu's and the form's positions), the app string key, the form's
    artifact, a media resource's path, and an element named only by its position by what the build holds there
    (``Sites.builds``)."""
    artifact = difference.artifact
    profile, slash, base = artifact.partition("/")
    artifact = base if slash and not profile.startswith(("form:", "app_strings:")) else artifact
    if artifact.startswith("form:") and _position(artifact[5:]):
        return ("form", artifact[5:], "xform", BELOW)
    if artifact.startswith("app_strings:"):
        steps = unescaped(difference.at)
        if len(steps) != 1:
            return NOWHERE
        if (APP_STRINGS, steps[0]) in sites.builds:
            return _site(sites.builds, (APP_STRINGS, steps[0]))
        return _app_strings_location(steps[0])
    steps = _xml_steps(difference.at)
    if artifact == "suite.xml":
        return _suite_location(artifact, steps, sites)
    if artifact == "media_suite.xml" and len(steps) >= 2 and steps[0] == "suite":
        resource = _identity(steps[1], "[resource/@id=")
        path = None if resource is None else sites.media.get(resource)
        return ("app", "multimedia_map", path) if path else NOWHERE
    if artifact in ("profile.ccpr", "profile.xml"):
        # The profile's name is the app's (``models/applications.py::Application.create_profile``); the rest is
        # the app's settings.
        return ("app", "name") if steps == ["profile", "@name"] else ("app", "profile", BELOW)
    return NOWHERE


def locate(difference, sites: Sites = NO_SITES) -> tuple[str, ...]:
    """Where ``difference`` stands in the tree the places name (the module's docstring): a tuple of steps, ``**``
    for everything below a step it stops at (a form's question order, a case list's header, which names no
    column), and the empty tuple where it names no place (``NOWHERE``), which only the change that stands
    everywhere stands at. Proofs 2 and 3 are read with ``sites``, what the document's records say of where each
    run, step, case and build element stands."""
    if difference.check == "source" or (difference.check == "proof1" and difference.artifact == "app.json"):
        return _app_location(unescaped(difference.at))
    if difference.check == "proof1":
        if difference.artifact == "android@local.ccz":
            return _site(sites.served, (difference.artifact, difference.at))
        steps = unescaped(difference.at)
        if difference.artifact.startswith("form:") and _position(difference.artifact[5:]):
            position = difference.artifact[5:]
            if len(steps) >= 2 and steps[0] == "questions":
                return ("form", position, "xform", *[step for step in steps[1].split("/") if step])
            if steps == ["order"]:
                return ("form", position, "xform", "data", BELOW)
            if steps and steps[0] == "case_updates":
                return ("form", position, *steps)
            return ("form", position, BELOW)
        if difference.artifact == "case_types":
            if len(steps) >= 3 and steps[1] == "properties":
                return ("case", steps[0], *_relation_steps(steps[2:]))
            return ("case", steps[0], BELOW) if steps else NOWHERE
        return NOWHERE
    if difference.check == "proof2":
        return _build_location(difference, sites)
    if difference.check == "proof3":
        return _trace_location(difference, sites)
    return NOWHERE


def _unshown_media_location(d, sites):
    """Only the whole unavailable-to-the-worker slot or its last file reference may disappear. The review
    supplies exact owners; the comparison must independently show the removal of the right kind of value."""
    if d.kind != "removed" or d.after is not None:
        return NOWHERE
    if d.check == "source" and d.path.startswith("/_attachments/*/data/*/:itext/"):
        where = locate(d)
        if (
            len(where) >= 9
            and where[-4] == ":itext"
            and where[-3] in ("hint", "constraintMsg", "label")
            and where[-1] in ("audio", "image", "video")
            and isinstance(d.before, str)
            and d.before.strip().startswith("jr://file/")
            and "<" not in d.before
        ):
            return where
    if d.path in ("/multimedia_map/*", "/modules/*/forms/*/media/*"):
        where = locate(d)
        if not where or not where[-1].startswith("jr://file/"):
            return NOWHERE
        if d.check == "source" and isinstance(d.before, dict) and d.before.get("doc_type") == "HQMediaMapItem":
            return where if d.before.get("multimedia_id") and d.before.get("unique_id") else NOWHERE
        if d.check == "proof1":
            expected = {"mapped": True} if d.path.endswith("/media/*") else {}
            return where if d.before == expected else NOWHERE
    if d.check != "proof2" or not isinstance(d.before, str):
        return NOWHERE
    from proof.checks.compare.xml_tree import XmlNotWellFormed, parse_xml

    try:
        element = parse_xml(d.before)
    except XmlNotWellFormed:
        return NOWHERE
    steps = _xml_steps(d.at)
    if d.artifact.rpartition("/")[2] == "media_suite.xml" and len(steps) == 2 and element.tag == "media":
        resources = element.findall("resource")
        if len(element) != 1 or len(resources) != 1 or resources[0].get("id") != _identity(steps[1], "[resource/@id="):
            return NOWHERE
        where = locate(d, sites)
        if not where:
            return NOWHERE
        local = resources[0].findall("location[@authority='local']")
        return where if len(local) == 1 and local[0].text == "./" + where[-1].removeprefix("jr://file/") else NOWHERE
    if len(steps) == 7 and element.tag == "{http://www.w3.org/2002/xforms}value":
        language, identity, kind = (_identity(steps[4], "[@lang="), _identity(steps[5]), _identity(steps[6], "[@form="))
        if kind and element.attrib == {"form": kind} and not len(element):
            return _site(sites.builds, (d.artifact, language, identity, kind, (element.text or "").strip()))
    return NOWHERE


def locations(difference, sites: Sites = NO_SITES) -> tuple[tuple[str, ...], ...]:
    """Every location ``difference`` stands at: ``locate``'s, and where CommCare HQ's build writes one text from
    two names, the other name's too. A suite's XForm resource's descriptor, ``Form: (Module <menu's name>) -
    <form's name>`` (``suite_xml/sections/resources.py::FormResourceContributor``), stands at its form's name and
    at its menu's."""
    location = locate(difference, sites)
    if _form_descriptor(difference) and len(location) == 3 and location[0] == "form" and location[2] == "name":
        return (location, ("menu", location[1].partition(".")[0], "name"))
    return (location,)


def _form_descriptor(difference) -> bool:
    """Whether ``difference`` is proof 2's at a suite's XForm resource's ``descriptor``."""
    if difference.check != "proof2" or difference.artifact.rpartition("/")[2] != "suite.xml":
        return False
    steps = _xml_steps(difference.at)
    return (
        len(steps) == 4
        and steps[0] == "suite"
        and _without_position(steps[1]) == "xform"
        and _without_position(steps[2]) == "resource"
        and steps[3] == "@descriptor"
    )


def exactness(place: str, location: tuple[str, ...]) -> int | None:
    """How exactly ``place`` stands at ``location``: None where the location is not at the place or under it,
    else the count of the place's steps the location names alike (a ``**`` of the place and the steps a location's
    ``**`` stands for name nothing alike). The empty place, the whole app, stands at every location, at 0, and is
    the only place that stands at a location that names no place (``NOWHERE``)."""
    steps = unescaped(place) if place else []

    def go(i: int, j: int) -> int | None:
        if i == len(steps):
            return 0
        if j < len(location) and location[j] == BELOW:
            return 0
        step = steps[i]
        if step == ANY_RUN:
            best = None
            for k in range(j, len(location) + 1):
                found = go(i + 1, k)
                if found is not None and (best is None or found > best):
                    best = found
                if k < len(location) and location[k] == BELOW:
                    break
            return best
        if j >= len(location):
            return None
        if location[j] == step:
            found = go(i + 1, j + 1)
            return None if found is None else found + 1
        return None

    return go(0, 0)


def _most_exact(places, located) -> int | None:
    """How exactly the most exact of ``places`` stands at any of the locations ``located``, None where none
    does."""
    found = [
        score for location in located for score in (exactness(place, location) for place in places) if score is not None
    ]
    return max(found) if found else None


# The register ------------------------------------------------------------------------


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
    if raw["check"] == "source" and any(covers(pattern, raw["path"]) for pattern in HELD_PATHS):
        raise ChangesError(
            f"{where} names {raw['path']}, where the stored-app comparison holds what Nova keeps of the app (a media"
            " path the document holds, the property a case list column shows). A first publish never declares a"
            " change there: a difference at it means the publish changed what it should have kept."
        )
    kind = raw.get("kind")
    if kind is not None and kind not in KINDS:
        raise ChangesError(f"{where}: kind {kind!r} is one of {sorted(KINDS)}, or left out for every kind.")
    return Row(raw["check"], raw["artifact"], raw["path"], kind)


def _kinds(raw, where) -> tuple[str, ...]:
    if not isinstance(raw, list) or not raw or not all(isinstance(kind, str) for kind in raw):
        raise ChangesError(
            f"{where}: placeKinds lists the kinds of place the change stands at, at least one"
            f" ({', '.join(sorted(PLACE_KINDS))})."
        )
    unknown = sorted(set(raw) - PLACE_KINDS)
    if unknown:
        raise ChangesError(
            f"{where}: placeKinds names {', '.join(unknown)}, which no place is ({sorted(PLACE_KINDS)})."
        )
    if len(set(raw)) != len(raw):
        raise ChangesError(f"{where}: placeKinds names a kind twice.")
    if APP_WIDE in raw and len(raw) > 1:
        raise ChangesError(
            f"{where}: placeKinds names {APP_WIDE} beside other kinds. A change stands everywhere or at places of"
            " its own, and only the one that stands everywhere names it."
        )
    return tuple(raw)


def parse(value, where="proof/first-publish-changes.json") -> tuple[Change, ...]:
    """The register's entries from the file's parsed JSON, in file order (``load``)."""
    if not isinstance(value, list):
        raise ChangesError(f"{where} is a list of {{change, placeKinds, rows}}, one object a change.")
    found, seen = [], set()
    for index, raw in enumerate(value):
        at = f"{where}[{index}]"
        if not isinstance(raw, dict) or set(raw) != CHANGE_KEYS:
            raise ChangesError(f"{at} holds exactly change, placeKinds and rows.")
        change = raw["change"]
        if not isinstance(change, str) or not change:
            raise ChangesError(f"{at}: change is a first-publish register id.")
        if change in seen:
            raise ChangesError(f"{where} holds two objects of the change {change}; one object a change holds its rows.")
        seen.add(change)
        kinds = _kinds(raw["placeKinds"], at)
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
        found.append(Change(change, tuple(rows), kinds))
    for change in found:
        whole = [row.path for row in change.rows if change.app_wide and _whole_form_source(row)]
        if whole:
            raise ChangesError(
                f"{where} names {', '.join(whole)} under {change.change}, which stands everywhere: the row covers every"
                " part of every form's source, so a change of any question would be held there and no other change"
                " of a form could be seen apart or found missing. Name each part class Nova's own spelling changes,"
                " written from a run's evidence (python3 -m proof.checks.changes rows)."
            )
    app_wide = [change.change for change in found if change.app_wide]
    if len(app_wide) > 1:
        raise ChangesError(
            f"{where} declares {', '.join(app_wide)} app-wide. One change alone stands everywhere and keeps what no"
            " other change's place holds; two such changes stand at every place alike, so no difference could show"
            " one apart from the other."
        )
    return tuple(found)


def _whole_form_source(row: Row) -> bool:
    """Whether a ``source`` row covers a form's whole source: ``/_attachments`` or one attachment, no part."""
    steps = tokens(row.path)
    return row.check == "source" and bool(steps) and steps[0] == "_attachments" and len(steps) <= 2


def load(path: Path = FIRST_PUBLISH_CHANGES) -> tuple[Change, ...]:
    """The file's entries in file order. Refuses two objects of one change, two rows of one class within an object,
    a check outside the four, a ``source`` row naming a place Nova keeps (``HELD_PATHS``), an entry that declares
    no kind of place or the whole app's beside another, and two entries that stand everywhere."""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ChangesError(f"{path} could not be read as JSON ({error}).") from error
    return parse(value, str(path))


def placed(document, register) -> dict[str, tuple[str, ...]]:
    """The changes that apply on ``document``, each with the places it stands at: on a document made in HQ, those
    its reading says the first publish makes (``corpus.Document.first_publish_places``), each held to its entry's
    kinds; on a corpus document whose saves in CommCare HQ are brought in, the changes of the next publish Nova's
    review of them lists (``corpus.Document.next_publish``). Unshown form media keeps the current reading's
    exact places. The other next-publish changes stand everywhere. None applies on any other document or control."""
    if getattr(document, "hq_authored", False):
        listed = dict(document.first_publish_places)
        by_id = {change.change: change for change in register}
        for change_id, places in listed.items():
            entry = by_id.get(change_id)
            where = f"{getattr(document, 'id', 'the document')}'s first-publish.json"
            if entry is None:
                raise ChangesError(f"{where} lists {change_id}, which the register holds no entry of.")
            if entry.app_wide:
                if tuple(places) != EVERYWHERE:
                    raise ChangesError(
                        f"{where} gives {change_id}, which stands everywhere, the places {list(places)}; its one"
                        ' place is the whole app, "".'
                    )
                continue
            if not places:
                raise ChangesError(
                    f"{where} gives {change_id} no place. Every change but the one that stands everywhere stands"
                    " at places of its own, which the emission writes from the reading."
                )
            for place in places:
                kind = place_kind(place)
                if kind is None or kind not in entry.kinds:
                    raise ChangesError(
                        f"{where} gives {change_id} the place {place!r}, of the kind {kind}, which its entry does"
                        f" not declare ({', '.join(entry.kinds)})."
                    )
        return {change_id: tuple(places) for change_id, places in listed.items()}
    if getattr(document, "kind", "corpus") == "control":
        return {}
    return {
        change_id: tuple(document.unshown_media_places) if change_id == UNSHOWN_MEDIA else EVERYWHERE
        for change_id in getattr(document, "next_publish", ()) or ()
    }


def _applying(document) -> frozenset[str]:
    """The ids of the entries that apply on ``document`` (``placed``)."""
    if getattr(document, "hq_authored", False):
        return frozenset(change_id for change_id, _ in document.first_publish_places)
    if getattr(document, "kind", "corpus") == "control":
        return frozenset()
    return frozenset(getattr(document, "next_publish", ()) or ())


@dataclass(frozen=True)
class ClaimPlaces:
    """Where the reader's claim log records its claims on the app's own JSON (``parity.claim_places``): the places of
    the records under an entry of standing inert, and the places of every other record."""

    inert: frozenset[str] = frozenset()
    other: frozenset[str] = frozenset()


NO_CLAIMS = ClaimPlaces()


def inert_holds(pointer: str, places: ClaimPlaces) -> bool:
    """Whether the inert allowance holds a difference at ``pointer``: an inert place is ``pointer`` or above it, and no
    record of another standing stands at or below that inert place on ``pointer``'s own branch (at ``pointer``, above
    it, or under it). Where one does, the log does not tell whether what changed is what the inert claim read."""

    def shares_branch(inert: str, other: str) -> bool:
        return _within(inert, other) and (_within(other, pointer) or _within(pointer, other))

    return any(
        _within(inert, pointer) and not any(shares_branch(inert, other) for other in places.other)
        for inert in places.inert
    )


def _held_by(difference, change: Change, places: ClaimPlaces) -> bool:
    """Whether a row of ``change`` names ``difference``'s class, or the inert allowance holds it for
    forms-and-settings-rewritten; never a difference at a place Nova keeps."""
    if held(difference) or not change.matches_value(difference):
        return False
    if any(row.matches(difference) for row in change.rows):
        return True
    return (
        change.change == INERT_ALLOWANCE
        and difference.check == "source"
        and difference.artifact == "app.json"
        and inert_holds(difference.at, places)
    )


def holders(
    difference,
    changes,
    applying: Mapping[str, tuple[str, ...]],
    places: ClaimPlaces = NO_CLAIMS,
    sites: Sites = NO_SITES,
):
    """The applying changes that hold ``difference`` and stand most exactly where it is: of the changes in
    ``applying`` a row of which names its class and a place of which stands at its location, those whose most exact
    place there is the most exact of all (``exactness``). Empty where no applying change holds it."""
    located = locations(difference, sites)
    scored = []
    for change in changes:
        where = applying.get(change.change)
        if where is None or not _held_by(difference, change, places):
            continue
        if change.change == UNSHOWN_MEDIA:
            owner = _unshown_media_location(difference, sites)
            # A nearby slot or an unknown location anywhere below this form cannot authorize a removal.
            score = len(owner) if owner and any(tuple(unescaped(place)) == owner for place in where) else None
        else:
            score = _most_exact(where, located)
        if score is not None:
            scored.append((change.change, score))
    if not scored:
        return []
    best = max(score for _, score in scored)
    return [change_id for change_id, score in scored if score == best]


def declared(
    document, check: str, differences, *, places: ClaimPlaces = NO_CLAIMS, sites: Sites = NO_SITES, register=None
):
    """``(held, ids)``: the differences of ``check`` an entry applying on ``document`` holds at one of its places
    (``holders``), and the ids of the entries that hold one most exactly. A ``source`` difference the inert allowance
    holds over ``places`` (``inert_holds``) is held by forms-and-settings-rewritten, and a difference at a place Nova
    keeps (``held``) by nothing. On a document no entry applies on, nothing is held."""
    changes = list(load() if register is None else register)
    applying = placed(document, changes)
    if not applying:
        return [], frozenset()
    found, ids = [], set()
    for difference in differences:
        if difference.check != check:
            continue
        holding = holders(difference, changes, applying, places, sites)
        if holding:
            found.append(difference)
            ids.update(holding)
    return found, frozenset(ids)


def undeclared(
    document, check: str, differences, *, places: ClaimPlaces = NO_CLAIMS, sites: Sites = NO_SITES, register=None
):
    """``differences`` without those ``declared`` holds: what goes on to the spelling rules and the registers."""
    found, _ = declared(document, check, differences, places=places, sites=sites, register=register)
    kept = {id(difference) for difference in found}
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
    places: ClaimPlaces = NO_CLAIMS,
    sites: Sites = NO_SITES,
    readers,
    register=None,
) -> list[Difference]:
    """Holds 1 and 2 of the judge on one document. ``checked`` is every difference of the checks the judge is handed,
    by check (on a document made in HQ the four, ``source`` among them; on one whose saves are brought in, proofs 1
    to 3); ``places`` is where the claim log records its claims, for the inert allowance (``declared``), none on a
    document not made in HQ; ``sites`` is what the document's records say of where proof 2's and proof 3's
    differences stand (``Sites``); ``readers`` is the set of served readers the run observes
    (``proof.lane.readers.named``). Answers the ``changes`` differences ``/<id>/unsaid`` (a difference no applying
    change holds at one of its places, which an entry that does not apply names, ``naming``: at most one a
    difference) and ``/<id>/unseen`` (an applying entry that holds no difference most exactly, but where every row
    of it names a served reader the run does not observe, or a check the judge was not handed)."""
    changes = list(load() if register is None else register)
    applying = placed(document, changes)
    return judged(document.id, applying, checked, places=places, sites=sites, readers=readers, register=changes)


def _row_exactness(row: Row) -> tuple[int, bool]:
    """How exactly a row names a class: the steps of its path, then whether it names a kind."""
    return len(tokens(row.path)), row.kind is not None


def naming(difference, changes, applying, sites=NO_SITES) -> str | None:
    """The one entry that names ``difference`` as a change of its own, where it does not apply: of the rows of the
    register that match the difference (``Row.matches``) and that no other entry holds too (a class two entries
    share names neither), the most exact (``_row_exactness``) belong to one entry, and that entry does not apply.
    None where no such row matches, where the most exact belong to several entries, or where they are an applying
    entry's, whose places miss the difference: the check that reports the difference says what it is, once, and
    the changes judge names no change for it."""
    holders_of: dict[Row, set[str]] = {}
    for change in changes:
        for row in change.rows:
            holders_of.setdefault(row, set()).add(change.change)
    matching = [
        (row, change.change)
        for change in changes
        for row in change.rows
        if len(holders_of[row]) == 1
        and row.matches(difference)
        and change.matches_value(difference)
        and (change.change != UNSHOWN_MEDIA or _unshown_media_location(difference, sites))
    ]
    if not matching:
        return None
    best = max(_row_exactness(row) for row, _ in matching)
    named = {change_id for row, change_id in matching if _row_exactness(row) == best}
    if len(named) != 1:
        return None
    (change_id,) = named
    return None if change_id in applying else change_id


def judged(
    document_id,
    applying: Mapping[str, tuple[str, ...]],
    checked: Mapping[str, Sequence[Difference]],
    *,
    places: ClaimPlaces = NO_CLAIMS,
    sites: Sites = NO_SITES,
    readers,
    register=None,
) -> list[Difference]:
    """``differences`` over the applying changes and their places as given (``placed``), which is all the judge
    reads of a document: what the ``changes`` check's evidence holds, so a run's judgment can be made again from
    it alone (``replay``)."""
    changes = list(load() if register is None else register)
    readers = frozenset(readers or ())
    found, seen = [], set()
    for check in ROW_CHECKS:
        for difference in checked.get(check, ()):
            if held(difference):
                continue
            holding = holders(difference, changes, applying, places, sites)
            if holding:
                seen.update(holding)
                continue
            change_id = naming(difference, changes, applying, sites)
            if change_id is not None:
                found.append(
                    _changes_difference(
                        document_id,
                        change_id,
                        "unsaid",
                        f"/{change_id}/unsaid/{check}/{difference.artifact}{difference.at}",
                        None,
                        difference.as_json(),
                    )
                )
    by_id = {change.change: change for change in changes}
    for change_id in sorted(set(applying) - seen):
        change = by_id.get(change_id)
        if change is not None and (_served_only(change, readers) or _unjudged(change, checked)):
            continue
        found.append(_changes_difference(document_id, change_id, "unseen", f"/{change_id}/unseen"))
    return found


def unsaid_message(document_id, difference: Difference) -> str:
    """A change Nova's publish made that its review would not have mentioned."""
    seen = difference.after or {}
    return (
        f"Publishing {document_id} to CommCare HQ changed something Nova's review would not have mentioned:"
        f" {difference.path.split('/')[1]}, seen at {seen.get('at')} by {seen.get('check')}. Either the change's"
        " rule in FIRST_PUBLISH_CHANGES misses this app, its places miss where it stands, or the publish should not"
        " have changed it (on an app made in HQ, the reader should not have held the shape that caused it)."
    )


def unseen_message(document_id, difference: Difference) -> str:
    """A change Nova's review mentions that nothing the lane ran showed at its places."""
    return (
        f"Nova's review of {document_id} says its publish makes the change {difference.path.split('/')[1]},"
        " and nothing the lane ran showed it at the places the reading gives it. Either the rule fires where the"
        " change does not happen, its places are not where it stands, or no row of the entry in"
        " proof/first-publish-changes.json names what this document shows there."
    )


# The evidence and its replay ---------------------------------------------------------


def evidence(applying, checked, *, places: ClaimPlaces = NO_CLAIMS, sites: Sites = NO_SITES, readers=()) -> dict:
    """Everything ``judged`` reads of one document, as the ``changes`` check writes it beside its differences: the
    applying changes with their places, where the claim log holds its claims, what the records say of where each
    difference stands, the served readers the run observes, and every difference of each check it was handed. A
    run's judgment is made again from it alone (``replay``), and each row a document needs is written from it
    (``rows``)."""
    return {
        "applying": [{"id": change_id, "places": list(where)} for change_id, where in applying.items()],
        "claims": {"inert": sorted(places.inert), "other": sorted(places.other)},
        "sites": sites.as_json(),
        "readers": sorted(readers or ()),
        "checked": {check: [difference.as_json() for difference in found] for check, found in checked.items()},
    }


@dataclass(frozen=True)
class Recorded:
    """What the ``changes`` check's evidence of one document says the judge read (``evidence``)."""

    document: str
    applying: Mapping[str, tuple[str, ...]]
    checked: Mapping[str, tuple[Difference, ...]]
    places: ClaimPlaces = NO_CLAIMS
    sites: Sites = NO_SITES
    readers: frozenset = frozenset()


DIFFERENCE_FIELDS = ("check", "document", "artifact", "path", "at", "kind", "before", "after")


def recorded(record) -> Recorded:
    """The judge's inputs from the ``changes`` check's evidence of one document, refused by name where the record
    predates ``evidence`` (it holds no ``checked``)."""
    if not isinstance(record, dict) or not isinstance(record.get("checked"), dict):
        raise ChangesError(
            "This changes evidence holds no checked differences, so the judgment cannot be made again from it: the"
            " changes check writes them beside its differences (changes.evidence) from layer 9 on. Run the lane again"
            " to write evidence the replay reads."
        )
    claims = record.get("claims") or {}
    return Recorded(
        document=record.get("document", ""),
        applying={one["id"]: tuple(one.get("places") or ()) for one in record.get("applying") or ()},
        checked={
            check: tuple(Difference(**{name: one.get(name) for name in DIFFERENCE_FIELDS}) for one in found)
            for check, found in record["checked"].items()
        },
        places=ClaimPlaces(frozenset(claims.get("inert") or ()), frozenset(claims.get("other") or ())),
        sites=Sites.from_json(record.get("sites")),
        readers=frozenset(record.get("readers") or ()),
    )


def replay(record, register=None) -> list[Difference]:
    """The ``changes`` differences ``judged`` gives over a document's evidence (``recorded``), with ``register``
    (the file's entries where None): the run's judgment again, or what it would be with this tree's register and
    judge."""
    found = recorded(record)
    return judged(
        found.document,
        found.applying,
        found.checked,
        places=found.places,
        sites=found.sites,
        readers=found.readers,
        register=register,
    )


def replayed(record, register=None) -> dict:
    """A document's judgment made again from its evidence, counted: the differences an applying change holds
    (``held``), those it holds not and no spelling of the register's would (``undeclared``, which the check that
    reports each holds to the known-defect register), the ``unsaid`` and the ``unseen``. A base is done where the
    last three are none."""
    changes = list(load() if register is None else register)
    found = recorded(record)
    held_count, undeclared_count = 0, 0
    for check in ROW_CHECKS:
        for difference in found.checked.get(check, ()):
            if not held(difference) and holders(difference, changes, found.applying, found.places, found.sites):
                held_count += 1
            else:
                undeclared_count += 1
    judgment = replay(record, changes)
    return {
        "document": found.document,
        "held": held_count,
        "undeclared": undeclared_count,
        "unsaid": sum(1 for difference in judgment if difference.path.endswith("/unsaid")),
        "unseen": sorted(
            difference.path.split("/")[1] for difference in judgment if difference.path.endswith("/unseen")
        ),
    }


# The rows command ------------------------------------------------------------------


def _records(output: Path, check: str, document: str) -> list[Path]:
    """Each record of ``check`` on ``document`` under ``output``: one lane run's output, or a directory holding a
    sharded run's outputs, one a shard (``proof-out-*``)."""
    name = f"checks/{check}/corpus-{document}.json"
    return sorted([*output.glob(f"blocks/*/{name}"), *output.glob(f"*/blocks/*/{name}")])


def _changes_record(output: Path, document: str):
    for path in _records(output, "changes", document):
        return json.loads(path.read_text(encoding="utf-8"))
    return None


@dataclass(frozen=True)
class _Evidence:
    check: str
    artifact: str
    path: str
    at: str
    kind: str
    before: object
    after: object


def _evidence(output: Path, document: str):
    """Each difference a check reported on the document, from each check's own record: those no change held."""
    found = []
    for check in ROW_CHECKS:
        for path in _records(output, check, document):
            record = json.loads(path.read_text(encoding="utf-8"))
            for difference in record.get("differences") or []:
                found.append(
                    _Evidence(
                        check,
                        difference["artifact"],
                        difference["path"],
                        difference["at"],
                        difference["kind"],
                        difference.get("before"),
                        difference.get("after"),
                    )
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


def _placed_in(output: Path, document: str) -> dict[str, tuple[str, ...]]:
    """The entries that apply on the document as the run's output holds it, each with its places (``placed``): the
    changes its ``first-publish.json`` lists, where it is made in HQ, and the next-publish ids its
    ``hq-side.json`` lists when it brings in saves. This legacy layout has no places for unshown media."""
    applying: dict[str, tuple[str, ...]] = {}
    first = _held_file(output, document, "first-publish.json")
    if isinstance(first, dict):
        for change in first.get("changes") or []:
            applying[change["id"]] = tuple(change.get("places") or ())
    saves = _held_file(output, document, "hq-side.json")
    if isinstance(saves, dict) and saves.get("republish") == "brings-in":
        for change_id in saves.get("publishChanges") or ():
            # Older replay evidence without exact places cannot authorize removing any source's media.
            applying[change_id] = () if change_id == UNSHOWN_MEDIA else EVERYWHERE
    return applying


def rows(output: Path, document: str, register=None) -> list[dict]:
    """For each difference of the document's evidence under ``output`` that no applying change holds at one of its
    places, ``{"row", "at"}``: the row that names its class (``source`` by its structural path, the others by
    check, artifact, path and kind) and the applying changes whose places stand most exactly where it is, which a
    person writes the row under where its change shows there; each row once, in the order of the evidence. A
    difference at a place Nova keeps (``held``) gets none: no row may name it.

    The judge's own inputs are read from the ``changes`` check's evidence (``evidence``): every difference it was
    handed, the places, the claims for the inert allowance and the sites. Evidence written before it held them is
    read as each check's own record of what no change held, with the places of the ``first-publish.json`` the
    output holds of the document and no claims."""
    changes = list(load() if register is None else register)
    record = _changes_record(output, document)
    if isinstance(record, dict) and isinstance(record.get("checked"), dict):
        found = recorded(record)
        applying, sites, places = found.applying, found.sites, found.places
        candidates = [difference for check in ROW_CHECKS for difference in found.checked.get(check, ())]
    else:
        applying = _placed_in(output, document)
        sites = Sites.from_json((record or {}).get("sites"))
        places = NO_CLAIMS
        candidates = _evidence(output, document)
    printed, seen = [], set()
    for evidence in candidates:
        if held(evidence) or holders(evidence, changes, applying, places, sites):
            continue
        row = Row(
            evidence.check, evidence.artifact, evidence.path, None if evidence.check == "source" else evidence.kind
        )
        if row in seen:
            continue
        seen.add(row)
        located = locations(evidence, sites)
        scored = [
            (change_id, score)
            for change_id, where in applying.items()
            if (score := _most_exact(where, located)) is not None
        ]
        best = max((score for _, score in scored), default=None)
        printed.append(
            {
                "row": row.as_json(),
                "at": sorted(change_id for change_id, score in scored if score == best),
            }
        )
    return printed


USAGE = (
    "Name a lane run's output (or a directory holding a sharded run's outputs) and a document:"
    " python3 -m proof.checks.changes rows <output> <document> prints the rows its unheld differences need;"
    " python3 -m proof.checks.changes replay <output> <document> makes the changes judgment again from its evidence."
)


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 3 or argv[0] not in ("rows", "replay"):
        print(USAGE, file=sys.stderr)
        return 2
    command, output, document = argv[0], Path(argv[1]), argv[2]
    if not output.is_dir():
        print(f"{output} is no directory a lane run wrote.", file=sys.stderr)
        return 2
    if command == "rows":
        for row in rows(output, document):
            print(json.dumps(row, ensure_ascii=False))
        return 0
    record = _changes_record(output, document)
    if record is None:
        print(f"{output} holds no changes evidence of {document}.", file=sys.stderr)
        return 2
    try:
        print(json.dumps(replayed(record), ensure_ascii=False))
    except ChangesError as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
