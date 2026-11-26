"""The stored-app comparison: on a document made in CommCare HQ, A's stored app against B's, as HQ's source read serves
each, the comparison the first-publish judge holds to what Nova's review says (``proof.checks.changes``).

The two are the parsed bodies of HQ's source answers to the unit's reads of
part ``a`` (label ``authored``) and part ``b`` (label ``published``)
(``proof.checks.observations.api_reads``). The two JSON values are walked
together, and each pointer where they differ is one ``Difference(check="source",
artifact="app.json")``: ``changed`` where both hold it, ``removed`` where A
alone does, ``added`` where B alone does. Its path writes every list position
and every key that is the app's own as ``*`` (a form's attachment, a language
code, a media path, a build profile's id; ``OWN_PATHS``, and a map whose every
key is one of the app's languages), kept in ``at``. A form's source is compared
by its parts, each at the data node it is about (``proof.checks.xform_parts``):
``/_attachments/*/data/*/:bind/@calculate`` at
``/_attachments/form:0.1.xml/data/visit/when/:bind/@calculate``, so a change Nova's
review lists meets a difference at the node it stands at; a form only one side
holds is one difference at ``/_attachments/*``. The parts are read with the
app's languages (both apps' ``langs``), so a translation in a language neither
holds is one part, and a slot's expression written another way is its own part
apart from a change of it (``xform_parts``, ``:respelled``). A language's
strings only one app holds are compared key by key, as are profile settings when
one app has no stored properties, so a change stands at the specific key.

Two things are compared another way, each for its reason at source:

- a form's ``unique_id`` and every reference to one (``case_list_form.form_id``,
  a form link's ``form_id``, ``shadow_parent_form_id``, a schedule phase's
  form): every source read mints them again
  (``models/applications.py::Application.export_json`` →
  ``scrub_source`` → ``util.py::update_form_unique_ids(source, ids_map={})``,
  each reference by ``models/base.py::form_id_references``), so each is compared
  as the menu and form position it names, and an attachment is paired with its
  form by that position;
- ``last_modified``, which ``ApplicationBase.save`` sets from the clock on every
  save of the app, so every publish moves it.

A media path the document holds (``hqAuthored.mediaPaths``) is compared apart:
its map item's ``multimedia_id`` and ``unique_id``, and the version of its
resource in A's and B's built media suites, each a difference at
``/multimedia_map/*/held``, which the first-publish judge never holds
(``changes.held``: no row matches it, however wide, and the register refuses
a row that names it), so a change to a path Nova holds is never a declared
change.

A case list column's ``field`` holds the property the column shows, or, where
``useXpathExpression`` is true, the expression it calculates
(``models/case_list.py::DetailColumn``; ``detail_screen.py`` reads ``field`` as
XPath only then). A calculated column's expression that differs, the column
calculated on both sides, is reported at its own pointer
(``/modules/*/case_details/<detail>/columns/*/field``), which
``forms-and-settings-rewritten`` names: Nova writes every expression it holds
in its own spelling. The exact legacy Translatable Text conversion is also compared as a ``field``.
Any other ``field`` that differs is reported at
``/modules/*/case_details/<detail>/columns/*/held``, which the first-publish
judge never holds either, so a first publish that changes which property a
column shows is never a declared change.

No spelling rule (``proof.rules``) is applied. A rule is proven where builds
are compared: on HQ's build, Core's run and the readers a rule names, never on
what else reads the stored app. A person reads the stored app on HQ's own
pages, and those tell rule-equal spellings apart (the form summary's
comparison of two versions marks a form whose ``form_filter`` is ``""`` in one
and null in the other as changed, ``proof/rules/form_filter_blank.py``; only
the app summary reads ``case_references_data.load``,
``proof/rules/case_references_load.py``). So every difference of the stored
app is one a first-publish entry names, or it fails the base.

Pure: it reads records and imports neither HQ nor Django.
"""

from __future__ import annotations

import hashlib
import json
import xml.etree.ElementTree as ElementTree
from dataclasses import replace

from proof.checks import observations, xform_parts
from proof.checks.changes import (
    HELD,
    LEGACY_SEARCH_GROUP_KEY,
    POSITIONAL_SEARCH_GROUP_KEY,
    SEARCH_GROUP_WORDING_PATH,
    legacy_related_case_formula,
)
from proof.checks.differences import Difference, pointer_token

CHECK = "source"
ARTIFACT = "app.json"
# What every save of an app sets from the clock (``models/applications.py::ApplicationBase.save``).
CLOCKED = frozenset({"last_modified"})
# The maps keyed by the app's own names beside the attachments and the media map, each compared apart: a language's
# translations and a build profile's id.
OWN_PATHS = frozenset({"/translations", "/build_profiles"})
# A language's strings, compared key by key even where only one app holds the language (``_Walk.strings``).
TRANSLATIONS = "/translations/*"
MEDIA_PREFIX = "jr://file/"


def form_positions(app) -> dict[str, str]:
    """Each form's ``unique_id`` in ``app`` by the position token that names it there (``form:<m>.<f>``)."""
    found = {}
    for m, module in enumerate(app.get("modules") or []):
        for f, form in enumerate((module or {}).get("forms") or []):
            unique_id = (form or {}).get("unique_id")
            if isinstance(unique_id, str):
                found[unique_id] = f"form:{m}.{f}"
    return found


def by_position(app) -> dict:
    """``app`` with every form id and every reference to one written as the position it names, the clocked fields
    left out, and each attachment keyed by its form's position."""
    app = json.loads(json.dumps(app))
    positions = form_positions(app)

    def named(value):
        return positions.get(value, value) if isinstance(value, str) else value

    for module in app.get("modules") or []:
        if not isinstance(module, dict):
            continue
        case_list_form = module.get("case_list_form")
        if isinstance(case_list_form, dict) and "form_id" in case_list_form:
            case_list_form["form_id"] = named(case_list_form["form_id"])
        for phase in module.get("schedule_phases") or []:
            for scheduled in (phase or {}).get("forms") or []:
                if isinstance(scheduled, dict) and "form_id" in scheduled:
                    scheduled["form_id"] = named(scheduled["form_id"])
        for form in module.get("forms") or []:
            if not isinstance(form, dict):
                continue
            if "unique_id" in form:
                form["unique_id"] = named(form["unique_id"])
            if "shadow_parent_form_id" in form:
                form["shadow_parent_form_id"] = named(form["shadow_parent_form_id"])
            for link in form.get("form_links") or []:
                if isinstance(link, dict) and "form_id" in link:
                    link["form_id"] = named(link["form_id"])
    attachments = app.get("_attachments")
    if isinstance(attachments, dict):
        app["_attachments"] = {
            f"{positions.get(name.removesuffix('.xml'), name.removesuffix('.xml'))}.xml": text
            for name, text in attachments.items()
        }
    for key in CLOCKED:
        app.pop(key, None)
    return app


def _languages(*apps) -> frozenset[str]:
    return frozenset(lang for app in apps for lang in (app.get("langs") or []) if isinstance(lang, str))


def _digest(text):
    if text is None:
        return None
    data = text if isinstance(text, str) else json.dumps(text, sort_keys=True)
    return "sha256:" + hashlib.sha256(data.encode("utf-8")).hexdigest()


class _Walk:
    def __init__(self, document, langs, held_paths):
        self.document = document
        self.langs = langs
        self.held_paths = held_paths
        self.found = []

    def add(self, path, at, kind, before, after):
        self.found.append(Difference(CHECK, self.document, ARTIFACT, path, at, kind, before, after))

    def own(self, path: str, value: dict) -> bool:
        """Whether ``value``'s keys are the app's own names, each written ``*``: a language's translations and a build
        profile by their code and id, and a map whose every key is one of the app's languages. A translation's own
        key (``app.display.name``) is CommCare's vocabulary."""
        if path in OWN_PATHS:
            return True
        if path == "/translations/*":
            return False
        return bool(value) and set(value) <= self.langs

    def compare(self, a, b, path="", at=""):
        if path == "/_attachments":
            self.attachments(a or {}, b or {})
            return
        if path == "/multimedia_map":
            self.media_map(a or {}, b or {})
            return
        if isinstance(a, dict) and isinstance(b, dict):
            starred = self.own(path, {**a, **b})
            column = _is_column(path) and "field" in a and "field" in b
            if column and not _same(a["field"], b["field"]):
                if (_calculated(a) and _calculated(b)) or _legacy_case_text_projection(a, b):
                    self.add(f"{path}/field", f"{at}/field", "changed", a["field"], b["field"])
                else:
                    self.add(f"{path}/{HELD}", f"{at}/{HELD}/field", "changed", a["field"], b["field"])
            for key in sorted(set(a) | set(b), key=str):
                if column and key == "field":
                    continue  # compared above, by what the column shows
                step = "*" if starred else pointer_token(key)
                child_path, child_at = f"{path}/{step}", f"{at}/{pointer_token(key)}"
                if child_path == TRANSLATIONS and (key not in a or key not in b):
                    self.strings(a.get(key), b.get(key), child_path, child_at)
                elif (
                    child_path == "/profile/properties"
                    and (key not in a or key not in b)
                    and isinstance(properties := a.get(key, b.get(key)), dict)
                    and properties
                ):
                    self.compare(a.get(key, {}), b.get(key, {}), child_path, child_at)
                elif key not in b:
                    self.add(child_path, child_at, "removed", a[key], None)
                elif key not in a:
                    self.add(child_path, child_at, "added", None, b[key])
                else:
                    self.compare(a[key], b[key], child_path, child_at)
            return
        if isinstance(a, list) and isinstance(b, list):
            for index in range(max(len(a), len(b))):
                child_path, child_at = f"{path}/*", f"{at}/{index}"
                if index >= len(b):
                    self.add(child_path, child_at, "removed", a[index], None)
                elif index >= len(a):
                    self.add(child_path, child_at, "added", None, b[index])
                else:
                    self.compare(a[index], b[index], child_path, child_at)
            return
        if not _same(a, b):
            self.add(path or "/", at or "/", "changed", a, b)

    def strings(self, a, b, path, at):
        """A language's strings only one app holds, key by key: each key is one app string of HQ's build
        (``app_strings.py``), and a change stands at the key it names."""
        held = a if a is not None else b
        if not isinstance(held, dict) or not held:
            kind = "removed" if b is None else "added"
            self.add(path, at, kind, a, b)
            return
        self.compare(a if a is not None else {}, b if b is not None else {}, path, at)

    def attachments(self, a: dict, b: dict):
        for name in sorted(set(a) | set(b)):
            at = f"/_attachments/{pointer_token(name)}"
            before, after = a.get(name), b.get(name)
            if before == after:
                continue
            if before is None or after is None or not isinstance(before, str) or not isinstance(after, str):
                kind = "removed" if after is None else "added" if before is None else "changed"
                self.add("/_attachments/*", at, kind, _digest(before), _digest(after))
                continue
            for kind, part_at, part_path, was, now in xform_parts.compare(before, after, self.langs or None):
                self.add(f"/_attachments/*{part_path}", f"{at}{part_at}", kind, was, now)

    def media_map(self, a: dict, b: dict):
        for name in sorted(set(a) | set(b)):
            if name in self.held_paths:
                continue  # a held path is compared apart (``held_media``)
            step = f"/multimedia_map/{pointer_token(name)}"
            if name not in b:
                self.add("/multimedia_map/*", step, "removed", a[name], None)
            elif name not in a:
                self.add("/multimedia_map/*", step, "added", None, b[name])
            else:
                self.compare(a[name], b[name], "/multimedia_map/*", step)


def _is_column(path) -> bool:
    """Whether ``path`` is a case list column's: ``/modules/*/case_details/<detail>/columns/*``."""
    parts = path.split("/")
    return len(parts) == 7 and parts[:4] == ["", "modules", "*", "case_details"] and parts[5:] == ["columns", "*"]


def _calculated(column) -> bool:
    """Whether a stored column holds an expression in its ``field`` (``DetailColumn.useXpathExpression``)."""
    return column.get("useXpathExpression") is True


def _legacy_case_text_projection(before, after) -> bool:
    """A legacy relation rendered through HQ's Translatable Text editor as the
    exact same calculation with the exact same stored translations."""
    if (before.get("model") != "case" or after.get("model") != "case"
            or before.get("format") != "translatable-enum" or after.get("format") != "translatable-enum"
            or before.get("useXpathExpression") is not False or after.get("useXpathExpression") is not True
            or not legacy_related_case_formula(before["field"], after["field"])):
        return False
    original, converted = before.get("enum"), after.get("enum")
    return (isinstance(original, list) and isinstance(converted, list) and len(original) == len(converted)
            and all(isinstance(old, dict) and isinstance(new, dict) and old.get("value") == new.get("value")
                    for old, new in zip(original, converted)))


def _same(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    return type(a) is type(b) and a == b or (isinstance(a, (int, float)) and isinstance(b, (int, float)) and a == b)


def media_versions(suite: bytes | None) -> dict[str, str | None]:
    """Each resource of a built media suite (``media_suite.xml``) by its id, with its version
    (``suite_xml/generator.py::MediaSuiteGenerator.media_resources``: the id is
    ``id_strings.media_resource(unique_id, name)``)."""
    if not suite:
        return {}
    root = ElementTree.fromstring(suite)
    return {
        resource.get("id"): resource.get("version")
        for resource in root.iter()
        if resource.tag.rpartition("}")[2] == "resource" and resource.get("id")
    }


def media_resource_id(unique_id, path) -> str:
    """``id_strings.media_resource``: ``media-<unique id>-<the path's last segment>``."""
    name = path.removeprefix(MEDIA_PREFIX).rpartition("/")[2]
    return f"media-{unique_id}-{name}"


def held_media(document, a_map, b_map, held_paths, suites=(None, None)) -> list[Difference]:
    """Each media path the document holds whose map item's ``multimedia_id`` or ``unique_id`` differs between the two
    reads, or whose resource's version differs between A's and B's built media suites (``suites``), at
    ``/multimedia_map/*/held``."""
    found = []
    versions_a, versions_b = (media_versions(suite) for suite in suites)
    for path in sorted(held_paths):
        item_a, item_b = a_map.get(path) or {}, b_map.get(path) or {}
        at = f"/multimedia_map/{pointer_token(path)}/{HELD}"
        for key in ("multimedia_id", "unique_id"):
            if item_a.get(key) != item_b.get(key):
                found.append(
                    Difference(
                        CHECK,
                        document,
                        ARTIFACT,
                        f"/multimedia_map/*/{HELD}",
                        f"{at}/{key}",
                        "changed",
                        item_a.get(key),
                        item_b.get(key),
                    )
                )
        if suites != (None, None) and item_a.get("unique_id") and item_a.get("unique_id") == item_b.get("unique_id"):
            resource = media_resource_id(item_a["unique_id"], path)
            if versions_a.get(resource) != versions_b.get(resource):
                found.append(
                    Difference(
                        CHECK,
                        document,
                        ARTIFACT,
                        f"/multimedia_map/*/{HELD}",
                        f"{at}/version",
                        "changed",
                        versions_a.get(resource),
                        versions_b.get(resource),
                    )
                )
    return found



def _preserved_search_group_wording(a, b):
    """Identify locale differences only when both source snapshots keep the same heading and member run."""

    def groups(module):
        search = module.get("search_config")
        rows = search.get("properties") if isinstance(search, dict) else None
        if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
            return {}
        headings = [i for i, row in enumerate(rows) if row.get("is_group") is True]
        heading_keys = [rows[i].get("group_key") for i in headings]
        fields = {row.get("name") for row in rows
                  if row.get("is_group") is not True and isinstance(row.get("name"), str)}
        found = {}
        for index, end in zip(headings, (*headings[1:], len(rows))):
            header = rows[index]
            key = header.get("group_key")
            members = rows[index + 1:end]
            if (isinstance(key, str) and header.get("name") == key and key not in fields
                    and heading_keys.count(key) == 1
                    and members and all(row.get("group_key") == key and isinstance(row.get("name"), str)
                                        for row in members)):
                found[index] = (key, header.get("label"), tuple(row["name"] for row in members))
        return found

    originals, published = a.get("translations"), b.get("translations")
    if not isinstance(originals, dict) or not isinstance(published, dict):
        return set()
    found = set()
    languages = _languages(a, b)
    for menu, (before, after) in enumerate(zip(a.get("modules") or [], b.get("modules") or [])):
        if not isinstance(before, dict) or not isinstance(after, dict):
            continue
        canonical = groups(after)
        for index, (old, labels, members) in groups(before).items():
            new = f"group_header_{index}"
            if (not LEGACY_SEARCH_GROUP_KEY.fullmatch(old) or POSITIONAL_SEARCH_GROUP_KEY.fullmatch(old)
                    or canonical.get(index) != (new, labels, members)
                    or not isinstance(labels, dict)
                    or not all(isinstance(labels.get(code), str) and labels[code].strip()
                               for code in languages)):
                continue
            old, new = (f"search_property.m{menu}.{key}" for key in (old, new))
            if any(isinstance(table, dict) and new in table for table in originals.values()):
                continue
            for code, source in originals.items():
                target = published.get(code)
                if code not in languages or not isinstance(source, dict) or not isinstance(target, dict) or old in target:
                    continue
                wording = source.get(old)
                if isinstance(wording, str) and wording.strip() and target.get(new) == wording:
                    prefix = f"/translations/{pointer_token(code)}"
                    found.update((f"{prefix}/{old}", f"{prefix}/{new}"))
    return found

def compare_sources(document, a, b, held_paths=frozenset(), suites=(None, None)) -> list[Difference]:
    """Every difference between two source answers of one app, A's and B's (the module's docstring)."""
    a, b = by_position(a), by_position(b)
    walk = _Walk(document, _languages(a, b), frozenset(held_paths))
    walk.compare(a, b)
    rekeyed = _preserved_search_group_wording(a, b)
    return [
        replace(row, path=SEARCH_GROUP_WORDING_PATH) if row.at in rekeyed else row
        for row in walk.found
    ] + held_media(
        document, a.get("multimedia_map") or {}, b.get("multimedia_map") or {}, held_paths, suites
    )


def _source(reads, where):
    body = observations.answer_json(reads["source"])
    if not isinstance(body, dict):
        raise observations.RecordIncomplete(f"{where} holds no app source HQ served as JSON.")
    return body


def _suite(state):
    files = getattr(getattr(state, "build", None), "files", None) or {}
    return files.get("media_suite.xml")


def differences(document, records) -> list[Difference]:
    """The stored-app comparison on one document made in HQ, from its records, for each configuration."""
    held_paths = frozenset(((document.hq_authored_facts or {}).get("mediaPaths") or {}).values())
    found = []
    for name in sorted(document.exports):
        a = observations.api_reads(records, name, "a", "authored")
        b = observations.api_reads(records, name, "b", "published")
        if a is None or b is None:
            continue  # HQ holds no such state, which the bar reports, or the reads are proof 6's to miss
        view = observations.republish_view(records, name)
        suites = (_suite(view.a), _suite(view.b))
        found += compare_sources(
            document.id,
            _source(a, f"{document.id}'s {name}/a authored read"),
            _source(b, f"{document.id}'s {name}/b published read"),
            held_paths,
            suites,
        )
    return found
