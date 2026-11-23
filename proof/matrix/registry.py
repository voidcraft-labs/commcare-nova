"""The bases the lane authors in CommCare HQ, and the variants made over them.

A base is an app HQ's own pages, models and form builder make
(``proof/matrix/bases/``), retained whole under ``proof/hq-apps/<base>/``
(``proof.matrix.retain``) and read by Nova as the corpus document
``hq-authored:<base>``. ``BASES`` names every base, one module of
``proof/matrix/bases/`` each, in the order the lane authors them.

A variant is one change over a base, made in HQ and read where it is made:
a row of ``proof/matrix/variants.json``. ``load_variants`` reads the file
and refuses a row whose named change is no function of
``proof/matrix/variants/`` and a function there no row names, so neither a
row nor a change goes unseen.

A row names a menu or a form of its base by position, never by an id or an
``xmlns`` an authoring of the base minted: ``{"$menu": m}``, ``{"$form": [m,
f]}`` and, for the form's ``xmlns``, ``{"$xmlns": [m, f]}``, each an object
with that one key (``proof.matrix.ops.reference_of``). A reference stands in
a set-json change's value, at any depth, which ``ops.set_json`` resolves to
what the stored app holds at that position before the change, and a menu or
an ``xmlns`` reference in a ``holds`` fragment's key given as a list
(``[kind, ...parts]``), which the lane writes as the key's text with the id
HQ keeps for the base's menu there and the base's form's ``xmlns``
(``retain.py::hold_key``). ``load_variants`` refuses one anywhere else, a
form's id in a ``holds`` key (no external key names a form by its id), and
one that is not well formed.

A holding row names ``holds``, a list, which is empty where no fragment of
the document changes (an INERT entry, or one whose held value Nova derives).
A fragment keyed by ``app`` reads its pointer from the document root. An entity
fragment names its external key. In either case,
such a row is held by its reading being ``read`` and its claim log counting
the entry.

This module imports no HQ code: a base's ``build`` and a variant's change
import HQ inside the functions that run them.
"""

from __future__ import annotations

import importlib
import json
import pkgutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from proof.hq.configuration import Configuration

MATRIX = Path(__file__).resolve().parent
VARIANTS = MATRIX / "variants.json"
EXEMPTIONS = MATRIX / "exemptions.json"
# Every base's id, sorted: what the suites reading proof/hq-apps/ outside the lane hold the tree to.
BASES_JSON = MATRIX / "bases.json"
HQ_APPS = MATRIX.parent / "hq-apps"
HAND = MATRIX / "hand"


@dataclass(frozen=True)
class Declaration:
    """Where a reading of a base says the app runs: ``runs_only_on`` is ``web-apps``, ``android`` or None for both,
    and ``split_datetime`` whether its date-and-time questions are split, as the review offers each."""

    runs_only_on: str | None
    split_datetime: bool = False

    def __post_init__(self):
        if self.runs_only_on not in (None, "web-apps", "android"):
            raise ValueError(
                f"A declaration runs on web-apps, android or both (None); this one names {self.runs_only_on!r}."
            )

    def as_json(self):
        return {"runsOnlyOn": self.runs_only_on, "splitDatetime": self.split_datetime}


@dataclass(frozen=True)
class Base:
    """One app the lane authors in HQ.

    ``build`` is handed an ``Authoring`` (``proof.matrix.author``) and
    returns the id of the app HQ holds. ``configuration`` is the project
    space it is authored in, whole. ``exhibits`` names each manifest entry
    the base is built to exhibit, which its reading must count
    (``test_retained.py::test_a_base_exhibits_what_it_names``). ``vellum``
    names each ``(menu, form)`` position saved once in HQ's form builder
    after ``build``. ``declaration`` is the one it is read under, or None for
    the reading's preselected one. ``worker_location`` is the site code of the
    place its builder names as the worker's, or None. ``cases`` names each
    case its case database holds beside the generated ones, as ``(case type,
    ((property, value), ...))``, putting together values A gives one by one
    (``proof/matrix/seed.py::stated_cases``).
    """

    id: str
    build: Callable[..., str]
    configuration: Configuration
    exhibits: tuple[str, ...]
    vellum: tuple[tuple[int, int], ...] = ()
    declaration: Declaration | None = None
    # The site code of the place the base names as its worker's, which the case seed records.
    worker_location: str | None = None
    # The cases the base names beside the generated ones, which the case seed records.
    cases: tuple[tuple[str, tuple[tuple[str, str], ...]], ...] = ()

    def as_json(self):
        """The base as ``base.json`` records it: its configuration as one entry of a corpus document's
        ``configurations.json`` (``proof/checks/configurations.py::read_configurations``), the declaration it is
        read under (``"preselected"`` where it states none) and what it exhibits."""
        configuration = self.configuration
        return {
            "id": self.id,
            "configuration": {
                "flags": sorted(configuration.flags),
                "namedPrivileges": sorted(configuration.privileges),
                "commcareVersion": configuration.commcare_version,
                "commtrack": configuration.commtrack,
                "syncCasesOnFormEntry": configuration.sync_cases_on_form_entry,
                "caseSearchEnabled": configuration.case_search_enabled,
            },
            "declaration": "preselected" if self.declaration is None else self.declaration.as_json(),
            "exhibits": sorted(self.exhibits),
        }


# Every base, one module of proof/matrix/bases/ each. Imported after the two classes above, which each module
# builds its BASE from.
from proof.matrix.bases import (  # noqa: E402
    case_lists,
    connect_deliver,
    connect_learn,
    hq_advanced,
    hq_case_management,
    hq_expressions,
    hq_media,
    hq_questions,
    kept_settings,
    languages,
    lookup_aliases,
    lookup_names,
    lookups,
    menus,
    names,
    new_app,
    nova_then_builder,
    places,
    plain,
    project_languages,
    saved_pages,
    search,
    starter_agriculture,
    starter_health,
    starter_wash,
)

BASES: tuple[Base, ...] = (
    plain.BASE,
    new_app.BASE,
    saved_pages.BASE,
    starter_health.BASE,
    starter_agriculture.BASE,
    starter_wash.BASE,
    hq_media.BASE,
    kept_settings.BASE,
    languages.BASE,
    project_languages.BASE,
    menus.BASE,
    names.BASE,
    case_lists.BASE,
    search.BASE,
    lookups.BASE,
    lookup_aliases.BASE,
    lookup_names.BASE,
    places.BASE,
    connect_deliver.BASE,
    connect_learn.BASE,
    hq_questions.BASE,
    hq_expressions.BASE,
    hq_case_management.BASE,
    hq_advanced.BASE,
    nova_then_builder.BASE,
)


def base(base_id: str) -> Base:
    """The base named ``base_id``."""
    for found in BASES:
        if found.id == base_id:
            return found
    raise KeyError(f"No base is named {base_id}; the bases are {[found.id for found in BASES]}.")


# Variants ----------------------------------------------------------------------------------------------------------

STANDINGS = ("never", "fix-in-hq", "not-yet")
# The circumstance a reading reports where something of the source is left unclaimed, which names a surface key
# (its ``detail.name``) and no manifest entry: a row that expects it names it as its ``entry`` and the key as ``key``.
UNRECOGNIZED = "unrecognized"
CHANGE_OPS = ("set-json", "named")
PLACE_KINDS = (
    "app",
    "app-settings",
    "languages",
    "menu",
    "case-list",
    "case-detail",
    "search",
    "form",
    "question",
    "lookup-table",
    "media",
    "organization",
)


class VariantsRefused(ValueError):
    """``proof/matrix/variants.json`` holds a row the lane cannot make, or ``proof/matrix/variants/`` a change no row
    names."""


@dataclass(frozen=True)
class Refusal:
    """What a refusing row expects the reading to report: the finding's code, its standing and its place, and, for
    the circumstance ``unrecognized``, the surface key it names."""

    entry: str
    standing: str
    place: Mapping
    key: str | None = None


@dataclass(frozen=True)
class Variant:
    """One row of ``variants.json``. A refusing row may compose findings beside its own: ``second``, and ``also``,
    each ``{entry, standing, place, change}``, for a class that only stands beside other refused things, each its
    own cause (two columns a column depends on, each refused for itself). A row whose value HQ never serves may
    name no standing and hold nothing: its outcome is HQ's alone."""

    id: str
    base: str
    entry: str
    standing: str | None
    place: Mapping | None
    change: Mapping
    holds: tuple[Mapping, ...] = ()
    second: Mapping | None = None
    also: tuple[Mapping, ...] = ()
    hq_never_serves: Mapping | None = None
    key: str | None = None  # the surface key a row expecting ``unrecognized`` names

    @property
    def refusing(self) -> bool:
        """Whether the reading is to be an account (a row with a standing), or ``read`` holding ``holds``."""
        return self.standing is not None

    def composed(self) -> tuple[Mapping, ...]:
        """The findings the row composes beside its own, in order: its second's, then each of ``also``."""
        return (() if self.second is None else (self.second,)) + self.also

    def refusals(self) -> tuple[Refusal, ...]:
        """The findings a refusing row expects, its own and each it composes."""
        found = [Refusal(self.entry, self.standing, self.place, self.key)] if self.refusing else []
        found.extend(Refusal(one["entry"], one["standing"], one["place"]) for one in self.composed())
        return tuple(found)

    def changes(self) -> tuple[Mapping, ...]:
        """The changes the row makes, in order: its own and each composed finding's."""
        return (self.change, *(one["change"] for one in self.composed()))


def _named_changes() -> dict[str, Callable]:
    """Every public function of each module of ``proof/matrix/variants/``, by name, refusing a name two modules
    give."""
    from proof.matrix import variants as package

    found: dict[str, Callable] = {}
    where: dict[str, str] = {}
    for info in pkgutil.iter_modules(package.__path__):
        module = importlib.import_module(f"{package.__name__}.{info.name}")
        for name, value in vars(module).items():
            if name.startswith("_") or not callable(value) or getattr(value, "__module__", None) != module.__name__:
                continue
            if name in found:
                raise VariantsRefused(
                    f"The changes of proof/matrix/variants/ name {name} twice, in {where[name]} and {module.__name__};"
                    " a row names a change by its name alone, so give each its own."
                )
            found[name] = value
            where[name] = module.__name__
    return found


def _check_place(row_id, place):
    if not isinstance(place, Mapping) or place.get("kind") not in PLACE_KINDS:
        raise VariantsRefused(
            f"The variant {row_id} names the place {place!r}; a place is an HqPlace (lib/publish/hqFindings.ts),"
            f" whose kind is one of {list(PLACE_KINDS)}."
        )


def _refused_reference(row_id, error):
    return VariantsRefused(
        f"The variant {row_id} names a menu or form by position where the lane cannot resolve it: {error} A row names"
        " one by position only in a set-json value, and a menu or a form's xmlns in a holds key given as a list."
    )


def _check_references(row_id, row):
    """Each reference a row holds well formed, and only where the lane resolves one: a set-json value, and a menu or a
    form's xmlns in a list key of a ``holds`` fragment."""
    from proof.matrix.ops import ValueNotSet, references_in

    allowed = []
    for change in (
        row.get("change"),
        *(one.get("change") for one in (row.get("second"), *(row.get("also") or ())) if isinstance(one, Mapping)),
    ):
        if isinstance(change, Mapping) and change.get("op") == "set-json":
            allowed.append(("in its set-json value", change.get("value")))
    for hold in row.get("holds") or ():
        key = hold.get("key") if isinstance(hold, Mapping) else None
        if isinstance(key, list):
            allowed.append(("in a holds key", key))
    try:
        for where, value in allowed:
            found = references_in(value)
            if where == "in a holds key" and any(kind == "form" for kind, _ in found):
                raise _refused_reference(
                    row_id, 'a holds key names a form by its xmlns ({"$xmlns": [m, f]}), never by its id.'
                )
        # Every reference the row holds, beside those where the lane resolves one, is misplaced.
        everywhere = len(references_in(dict(row)))
    except ValueNotSet as error:
        raise _refused_reference(row_id, str(error)) from None
    if everywhere != sum(len(references_in(value)) for _, value in allowed):
        raise _refused_reference(row_id, "a place, a holds value or an hqNeverServes holds one.")


def _check_change(row_id, change, named):
    op = change.get("op") if isinstance(change, Mapping) else None
    if op not in CHANGE_OPS:
        raise VariantsRefused(
            f"The variant {row_id} makes the change {change!r}; a change is {{op: set-json, pointer, value}} or"
            " {op: named, name}."
        )
    if op == "set-json" and not (isinstance(change.get("pointer"), str) and "value" in change):
        raise VariantsRefused(f"The variant {row_id}'s set-json change names no pointer or no value.")
    if op == "named" and change.get("name") not in named:
        raise VariantsRefused(
            f"The variant {row_id} names the change {change.get('name')!r}, which no module of"
            " proof/matrix/variants/ defines. Write it there, in the module of the entry's manifest area."
        )


def load_variants(path: Path = VARIANTS, *, bases: tuple[Base, ...] | None = None, named=None) -> tuple[Variant, ...]:
    """The rows of ``variants.json`` in file order, each checked: an id given once, a base the registry names, a
    standing of ``never``, ``fix-in-hq`` or ``not-yet`` with a place, or ``holds`` in place of both, a list that is
    empty where no fragment of the document changes (or neither, on a row whose value HQ never serves), a change the
    lane can make, and composed findings (``second``, then
    ``also``, a list, only beside a ``second``) only beside a refusal. A row whose entry is the circumstance
    ``unrecognized`` names the surface key it leaves unclaimed (``key``), and no other row names one. A function of
    ``proof/matrix/variants/`` that no row names is refused as well."""
    known = {found.id for found in (BASES if bases is None else bases)}
    named = _named_changes() if named is None else named
    rows = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(rows, list):
        raise VariantsRefused(f"{path} holds one list of rows, and it holds a {type(rows).__name__}.")
    found: list[Variant] = []
    seen: set[str] = set()
    used: set[str] = set()
    for row in rows:
        row_id = row.get("id")
        if not isinstance(row_id, str) or row_id in seen:
            raise VariantsRefused(f"A row of {path} has the id {row_id!r}, which is missing or given twice.")
        seen.add(row_id)
        if row.get("base") not in known:
            raise VariantsRefused(f"The variant {row_id} is over the base {row.get('base')!r}, which BASES lacks.")
        if not row_id.startswith(f"{row['base']}/") and row.get("second") is None:
            raise VariantsRefused(f"The variant {row_id} is over {row['base']}, and its id does not start with it.")
        standing = row.get("standing")
        holds = row.get("holds")
        never = row.get("hqNeverServes")
        if holds is not None and not isinstance(holds, list):
            raise VariantsRefused(
                f"The variant {row_id} holds {holds!r}; holds is a list of {{key, pointer, value}} fragments, empty"
                " where no fragment of the document changes."
            )
        if standing is None:
            if (holds is None and never is None) or "place" in row:
                raise VariantsRefused(
                    f"The variant {row_id} names no standing, so it is a holding row, which names what the reading"
                    " holds (holds, a list, empty where no fragment changes) and no place, or a row whose value HQ"
                    " never serves (hqNeverServes)."
                )
        else:
            if standing not in STANDINGS:
                raise VariantsRefused(f"The variant {row_id}'s standing {standing!r} is none of {list(STANDINGS)}.")
            _check_place(row_id, row.get("place"))
            if holds is not None:
                raise VariantsRefused(f"The variant {row_id} refuses and holds; a row does one.")
        _check_change(row_id, row.get("change"), named)
        _check_references(row_id, row)
        key = row.get("key")
        if (row.get("entry") == UNRECOGNIZED) != (key is not None) or (
            key is not None and (not isinstance(key, str) or not key or standing is None)
        ):
            raise VariantsRefused(
                f"The variant {row_id} names the entry {row.get('entry')!r} and the key {key!r}. A row expecting the"
                f" circumstance {UNRECOGNIZED} names the surface key the reading leaves unclaimed (key) with its"
                " standing and place, and no other row names a key."
            )
        second = row.get("second")
        also = row.get("also")
        if also is not None and (second is None or not isinstance(also, list) or not also):
            raise VariantsRefused(
                f"The variant {row_id} composes also {also!r}; also is a non-empty list beside a second, each finding"
                " {entry, standing, place, change}."
            )
        composed = [] if second is None else [second, *(also or ())]
        if composed and standing is None:
            raise VariantsRefused(f"The variant {row_id} composes a second change beside no refusal of its own.")
        for one in composed:
            if not isinstance(one, Mapping) or one.get("standing") not in STANDINGS:
                raise VariantsRefused(f"A composed change of {row_id} names the standing {one!r}.")
            _check_place(row_id, one.get("place"))
            _check_change(row_id, one.get("change"), named)
        for change in (row["change"], *(one["change"] for one in composed)):
            if change["op"] == "named":
                used.add(change["name"])
        if never is not None and set(never) not in ({"raised"}, {"notServedAt"}):
            raise VariantsRefused(
                f"The variant {row_id}'s hqNeverServes is {never!r}; it is {{raised: <exception class>}} or"
                " {notServedAt: <pointer>}."
            )
        found.append(
            Variant(
                id=row_id,
                base=row["base"],
                entry=row["entry"],
                standing=standing,
                place=row.get("place"),
                change=row["change"],
                holds=tuple(holds or ()),
                second=second,
                also=tuple(also or ()),
                hq_never_serves=never,
                key=key,
            )
        )
    unused = sorted(set(named) - used)
    if unused:
        raise VariantsRefused(
            f"proof/matrix/variants/ defines {unused}, and no row of {path} names it, so the change is made by"
            " nothing. Give it its row, or remove it."
        )
    return tuple(found)


def named_change(name: str) -> Callable:
    """The function of ``proof/matrix/variants/`` called ``name``."""
    return _named_changes()[name]
