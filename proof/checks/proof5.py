"""Proof 5, locality: after an edit batch, every entity outside its footprint keeps its canonical digest.

The entities are the app, each module and each form, named by Nova id. The
footprint is the one the corpus wrote beside the batch
(``edit/batch.json``, ``proof/corpus/footprint.ts::batchFootprint``): the
entities the batch's mutations touch, every entity the reference index says
reads one of them (the plan's proof 5), and every entity whose wire Nova
derives from what the batch edits (``footprint.ts`` cites each derivation: a
module's settings its forms' wire carries, the form list the entries of the
modules nested under it are computed from, and the app-wide kinds the
app's own record carries). Its ``footprint`` list names the modules and
forms in it; its
``footprintParts`` say whether it reaches app-level state no module or form
owns (``app``) or every module and form (``appWide``, a language-catalog or
Connect-type edit). An ``appWide`` batch reaches the app's own record too,
and says so (``app``): its mutations edit the app's language catalog or
Connect type, which that record carries (``lib/commcare/expander.ts``
writes ``langs``, and ``translations`` naming every language in every
language, from the catalog, and ``auto_gps_capture`` from the Connect type
through ``hqShells.ts::applicationShell``).

What is compared is Nova's emitted wire, never what HQ makes of it:

- the app JSON of D's next publish (``export/<configuration>/republish``,
  its ``app_file`` field) against the app JSON of D''s publish
  (``edit/export/<configuration>/update``), under every configuration D is
  published under where Nova's publish accepts D' too (decision 19, read
  from ``edit/verdict.json``). The app's record is that JSON without its
  modules and attachments; a module's is its JSON with each form named only
  by its ``unique_id`` (a module's wire lists its forms; each form's own
  wire is the form's record); a form's is its JSON (``app.json``, at
  ``/modules/<m>/forms/<f>``) and its XForm source, the attachment
  ``<unique_id>.xml`` HQ reads as the form's source
  (``app_manager/models/forms.py::FormSource``), as ``form:<m>.<f>``;
- each form's XForm in D's local archive against D''s
  (``local:form:<m>.<f>``, ``modules-<m>/forms-<f>.xml``);
- each entity's part of the local archive's suite and app strings
  (``local:suite.xml``, ``local:app_strings:<lang>``, ``suite_comparison``): a
  form's entry; a module's menu with every remote request and view entry it
  lists, and the details it emits (those its own case selection names: the
  last datum naming a detail in each entry of its forms, views and remote
  requests, or a detail only its entries name, such as a search's results;
  a parent's selection names another module's by id); each with the app
  strings every ``locale`` in them names, in every language. Which suite
  element is whose is read from Core's parse of the archive (the ``local``
  record's admission: each menu's commands, each entry's form ``xmlns``),
  never from an id's text: an entry is its form's by the ``xmlns`` Core read
  for it, a menu its module's by the forms its commands open (a menu that
  opens no form, a case list's, is placed by its order among such menus and
  the modules that hold no form). The archive names a module's and a form's
  parts by position (``m<i>``, ``m<i>-f<j>``, ``m<i>_case_short``, the keys
  of their app strings, and a stack step's command, an XPath literal), so
  D''s are mapped to D's: a menu's and an entry's id by the entity Core says
  it is, a detail's by the datum of the paired entry that names it, an app
  strings key by the place of its ``locale`` in the paired elements, and a
  stack step's value by the string Core reads it as (the ``local`` record's
  ``stackValues``; a step whose value Core reads as one string is compared as
  that string, mapped). The no-matches return guard also compares a session
  datum with the offered menu command. Its exact Core-lexed guard shape maps
  only that command literal; changed conditions and other data stay intact.
  An element no entity owns (a menu Core reads no
  module for, an endpoint whose stack opens no known command) is the app's.

  A detail, entry or remote request no runtime reads (``unread``: nothing a
  menu, an endpoint, a datum or a stack step reaches) has no owner in
  Core's parse, and is compared all the same (``_place_unread``). Where
  the other archive names the same element and an entity at the same
  position there owns it, it is that entity's: the same element, read on
  one side (a datum the edit removed or added). Every other is unowned
  (``UNOWNED``), compared as one record with each element's own name and
  every ``locale`` read out (the strings it names, in every language), so
  a module that moves keeps it. It is inside the footprint where the
  footprint reaches the app, as every element Core's parse places with no
  entity is, or holds every module of D and D': Nova emits each detail and
  each search's remote request inside its per-module loop
  (``lib/commcare/compiler.ts::compileCcz``), so an unread one is some
  module's. The other remote requests, an entry point's claims, are emitted
  outside that loop (``lib/commcare/entryPointSuite.ts::
  buildEntryPointSuite``) and are never unread: the endpoint that needs one
  pushes its command. Which module an unread element is, only its
  positional name says, so this placement errs both ways: a change to one
  of a module outside a footprint that reaches the app passes, and a change
  to one of a module inside a footprint that neither reaches the app nor
  holds every module fails.

An input either side lacks is refused rather than skipped
(``CorpusLayoutError``): a configuration D is published under where D' has
no publish though Nova's would send it, one local archive without the
other, or a document where nothing at all is compared. A record one side
holds that does not parse is a ``refused`` difference at
``<record>/not-well-formed``, its cause.

Every comparison names elements and keys as the comparators do: an
XForm's data (``compare.names``: the app's question, group and repeat ids
``*``, a case block's parts kept, binds and setvalues keyed by the node
they name), and each translated field of the app JSON keyed by its
language (``compare.app_json.LANGUAGE_MAPS``).

Positions are D's (D''s for an entity only D' holds). Each module and form
is placed by the wire layout the corpus recorded for D and for D'
(``document.json``'s ``wire.modules``), and paired by Nova id, so an edit
that moves, adds or removes one leaves every other entity paired with
itself. Every export mints its module and form ids and ``xmlns`` anew
(proof 1 judges that), so D''s are mapped to D's as proof 2 maps them
(``proof.observe.alignment``): every value equal to one of D''s ids is
replaced by D's id for the same Nova entity, and each D' form's data node
is moved into D's namespace. Nothing of D''s replaced ids may be left in
what is compared (``AlignmentIncomplete``).

Each record is read as a parsed structure, after the spelling rules
registered for its artifact (``proof.rules``): JSON as its values, an XForm
as the tree ``compare.xml_tree`` reads (namespace and local name, attributes
by namespace and local name, text with comments and processing
instructions dropped, children in order, and every text exact: these are
Nova's own bytes, not HQ's re-indented build). The digest is the
SHA-256 of that structure written canonically. An entity outside the
footprint whose digest changed is reported with every structural
difference the comparators find in it; a digest that changed with no
difference the comparators find is the harness's fault
(``DigestDisagrees``).

``entity_changes`` names every entity whose wire changed, inside the
footprint or not, so a footprint can be held against what the batch
actually changed.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from dataclasses import dataclass, field

from lxml import etree

from proof.checks.compare.app_json import DATA_MAPS
from proof.checks.compare.app_json import language_maps as _language_maps
from proof.checks.compare.json_tree import compare_json
from proof.checks.compare.xml_tree import (
    NOT_WELL_FORMED,
    XmlNotWellFormed,
    compare_xml_trees,
    element_content,
    parse_xml,
    qname,
)
from proof.checks.corpus import CorpusLayoutError
from proof.checks.differences import Difference
from proof.observe.alignment import Alignment, AlignmentIncomplete, map_values, renamespace_xform
from proof.observe.identity import data_namespace
from proof.rules import normalized
from proof.rules._xpath import tokens

APP = "app"
# The entity holding the suite elements no runtime reads and no entity owns, with every module of D and D':
# ``(UNOWNED, (module uuid, ...))``.
UNOWNED = "unowned"


class DigestDisagrees(AssertionError):
    """An entity's digest changed, and the comparators found no difference in it."""


@dataclass(frozen=True)
class Footprint:
    """The edit batch's footprint as the corpus wrote it."""

    entities: frozenset
    app: bool
    app_wide: bool

    @property
    def reaches_app(self):
        """Whether the footprint holds the app's own record (``app``, which an app-wide edit sets too)."""
        return self.app

    def holds(self, entity):
        kind, uuid = entity
        if kind == APP:
            return self.reaches_app
        if kind == UNOWNED:
            return self.reaches_app or self.app_wide or all(module in self.entities for module in uuid)
        return self.app_wide or uuid in self.entities

    def without(self, entity):
        """The footprint with one entity dropped (``("app", None)`` drops the app's own record).

        An app-wide footprint lists every module and form among its
        entities, so it becomes the footprint of exactly those entities and
        the app's record, less the one dropped.
        """
        kind, uuid = entity
        if kind == APP:
            return Footprint(self.entities, False, False)
        return Footprint(self.entities - {uuid}, self.reaches_app, False)


def footprint_of(document) -> Footprint:
    """The footprint ``edit/batch.json`` holds: its entity list and its app-level parts."""
    parts = document.edit.batch.get("footprintParts")
    if (
        not isinstance(parts, dict)
        or not isinstance(parts.get("app"), bool)
        or not isinstance(parts.get("appWide"), bool)
    ):
        raise CorpusLayoutError(
            f"{document.edit.root / 'batch.json'} holds no footprintParts with app and appWide, so it does not say"
            " whether the batch reaches the app's own state (proof/corpus/footprint.ts::batchFootprint)."
        )
    return Footprint(document.edit.footprint, parts["app"], parts["appWide"])


# Canonical forms ----------------------------------------------------------


def _canonical_json(value):
    """``value`` as the JSON comparator reads it: a number by its value (``1`` and ``1.0`` are one number)."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, list):
        return [_canonical_json(item) for item in value]
    return {key: _canonical_json(item) for key, item in value.items()}


def canonical_xml(element):
    """An XML element as ``compare.xml_tree`` reads it, with every text exact."""
    namespace, local = qname(element.tag)
    attributes = []
    for key, value in element.attrib.items():
        attribute_namespace, attribute = qname(key)
        attributes.append([attribute_namespace or "", attribute, value])
    text, children = element_content(element, "exact")
    return [
        namespace or "",
        local,
        sorted(attributes),
        text,
        [[canonical_xml(child), tail] for child, tail in children],
    ]


def digest(canonical):
    """The SHA-256 of a canonical structure, written with sorted keys and no insignificant space."""
    written = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(written.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Record:
    """One entity's record of one artifact: what is compared, and its digest."""

    kind: str  # "json", "xml", "absent" or "unreadable"
    value: object  # the JSON value, the lxml root, None, or the parser's message
    digest: str | None

    @classmethod
    def of_json(cls, value):
        canonical = _canonical_json(value)
        return cls("json", canonical, digest(canonical))

    @classmethod
    def of_xml(cls, artifact, source):
        if source is None:
            return cls("absent", None, None)
        try:
            root = normalized(artifact, parse_xml(source))
        except XmlNotWellFormed as error:
            return cls("unreadable", str(error), None)
        return cls("xml", root, digest(canonical_xml(root)))


# The emitted wire, by Nova entity ------------------------------------------


@dataclass
class Side:
    """One side's records and positions, by entity (``("app", None)``, ``("module", uuid)``, ``("form", uuid)``)."""

    positions: dict = field(default_factory=dict)  # entity -> its position on this side
    records: dict = field(default_factory=dict)  # entity -> {record name: Record}


def _placed(modules, where):
    """Each module uuid -> its wire index, and each form uuid -> (module index, form index)."""
    placed_modules, placed_forms = {}, {}
    for m, module in enumerate(modules):
        if module["uuid"] in placed_modules:
            raise CorpusLayoutError(f"{where} places the module {module['uuid']} twice on the wire.")
        placed_modules[module["uuid"]] = m
        for f, form in enumerate(module["forms"]):
            if form in placed_forms:
                raise CorpusLayoutError(f"{where} places the form {form} twice on the wire.")
            placed_forms[form] = (m, f)
    return placed_modules, placed_forms


def _app_file(captured):
    from proof.hq.operations import upload_field

    try:
        return json.loads(upload_field(captured.upload(), "app_file"))
    except (ValueError, UnicodeDecodeError) as error:
        raise CorpusLayoutError(
            f"{captured.body_path} carries no app_file JSON Nova's publish sends ({error})."
        ) from error


def _check_layout(app_json, modules, where):
    shape = [len(module.get("forms", [])) for module in app_json.get("modules", [])]
    if shape != [len(module["forms"]) for module in modules]:
        raise CorpusLayoutError(
            f"{where}: the wire layout places {[len(module['forms']) for module in modules]} forms per module, and"
            f" the captured app JSON holds {shape}; the layout and the capture are not of one document."
        )


def _alignment(before_ids, after_ids):
    """D''s ids paired with D's by Nova entity, as ``alignment.Alignment`` (positions named by entity)."""
    module_ids, form_ids, xmlns, unmatched = [], [], [], []
    for entity in sorted(set(before_ids) | set(after_ids), key=str):
        name = f"{entity[0]}:{entity[1]}"
        if entity not in before_ids or entity not in after_ids:
            unmatched.append(name)
            continue
        before, after = before_ids[entity], after_ids[entity]
        if entity[0] == "module":
            module_ids.append((name, after["unique_id"], before["unique_id"]))
        else:
            form_ids.append((name, after.get("unique_id"), before.get("unique_id")))
            xmlns.append((name, after.get("xmlns"), before.get("xmlns")))
    return Alignment(tuple(module_ids), tuple(form_ids), tuple(xmlns), tuple(unmatched))


def _ids(app_json, placed_modules, placed_forms):
    ids = {}
    for uuid, m in placed_modules.items():
        ids[("module", uuid)] = {"unique_id": app_json["modules"][m].get("unique_id")}
    for uuid, (m, f) in placed_forms.items():
        form = app_json["modules"][m]["forms"][f]
        ids[("form", uuid)] = {"unique_id": form.get("unique_id"), "xmlns": form.get("xmlns")}
    return ids


def _source(app_json, unique_id):
    source = (app_json.get("_attachments") or {}).get(f"{unique_id}.xml")
    return source.encode("utf-8") if isinstance(source, str) else source


def _upload_side(app_json, placed, sources, alignment, *, mapped, artifact_positions):
    """The records of one side's app JSON; ``mapped`` names D' (its ids moved to D's)."""
    placed_modules, placed_forms = placed
    if mapped:
        app_json = map_values(app_json, alignment.value_map())
    app_json = normalized("app.json", app_json)
    side = Side()
    side.positions[(APP, None)] = None
    side.records[(APP, None)] = {
        "app.json": Record.of_json({k: v for k, v in app_json.items() if k not in ("modules", "_attachments")})
    }
    for uuid, m in placed_modules.items():
        module = app_json["modules"][m]
        record = {k: v for k, v in module.items() if k != "forms"}
        record["forms"] = [{"unique_id": form.get("unique_id")} for form in module.get("forms", [])]
        side.positions[("module", uuid)] = m
        side.records[("module", uuid)] = {"app.json": Record.of_json(record)}
    for uuid, (m, f) in placed_forms.items():
        entity = ("form", uuid)
        source = sources.get(uuid)
        target = alignment.xmlns_at(f"form:{uuid}") if mapped else None
        if source is not None and target:
            source = renamespace_xform(source, target)
        position = artifact_positions.get(entity, (m, f))
        side.positions[entity] = (m, f)
        side.records[entity] = {
            "app.json": Record.of_json(app_json["modules"][m]["forms"][f]),
            "form": Record.of_xml(f"form:{position[0]}.{position[1]}", source),
        }
    return side


def _local_sources(path, placed_forms):
    """Each form's XForm in a local archive, by Nova uuid, refusing a form file the layout does not place."""
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        sources = {}
        expected = set()
        for uuid, (m, f) in placed_forms.items():
            name = f"modules-{m}/forms-{f}.xml"
            expected.add(name)
            sources[uuid] = archive.read(name) if name in names else None
    extra = sorted(
        name
        for name in names
        if name.startswith("modules-") and "/forms-" in name and name.endswith(".xml") and name not in expected
    )
    if extra:
        raise CorpusLayoutError(f"{path} holds {extra}, forms the wire layout does not place.")
    return sources


def _local_side(sources, alignment, *, mapped, artifact_positions, placed_forms):
    side = Side()
    for uuid, (m, f) in placed_forms.items():
        entity = ("form", uuid)
        source = sources.get(uuid)
        target = alignment.xmlns_at(f"form:{uuid}") if mapped else None
        if source is not None and target:
            source = renamespace_xform(source, target)
        position = artifact_positions.get(entity, (m, f))
        side.positions[entity] = (m, f)
        side.records[entity] = {"local": Record.of_xml(f"local:form:{position[0]}.{position[1]}", source)}
    return side


# The local suite, by Nova entity -----------------------------------------------

SUITE = "local:suite.xml"
STRINGS = "local:app_strings"
# The datum attributes that name a detail.
DETAIL_REFERENCES = ("detail-select", "detail-confirm", "detail-persistent", "detail-inline")
# What a stack step's value Core reads as one string is compared as: the string, after this mark.
READ_AS = "\u2047read:"


@dataclass
class _Suite:
    """One local archive's suite and app strings, with Core's parse of them (the ``local`` record's)."""

    root: object
    strings: dict  # language -> {key: value}
    readings: dict  # stack step value -> Core's string reading
    hole: str
    elements: dict  # (tag, id) -> element: menu, entry and remote-request by command id, detail by id
    menus: list  # Core's menus, in order: {id, root, commands}
    entries: dict  # command -> Core's entry: {xmlns, view, remoteRequest}


def _read_suite(path, admission, readings, hole):
    from proof.checks.compare.app_strings import parse_app_strings

    with zipfile.ZipFile(path) as archive:
        root = parse_xml(archive.read("suite.xml"))
        strings = {
            name.partition("/")[0]: parse_app_strings(archive.read(name))
            for name in sorted(archive.namelist())
            if name.count("/") == 1 and name.endswith("/app_strings.txt")
        }
    return suite_of(root, strings, admission, readings, hole)


def suite_of(root, strings, admission, readings, hole):
    """A parsed suite with its app strings and Core's parse of it (its admission report and stack readings)."""
    elements = {}
    for child in root:
        if not isinstance(child.tag, str):
            continue
        tag = qname(child.tag)[1]
        if tag in ("detail", "menu"):
            elements[(tag, child.get("id"))] = child
        elif tag in ("entry", "remote-request", "endpoint"):
            command = next(
                (c.get("id") for c in child if isinstance(c.tag, str) and qname(c.tag)[1] == "command"), None
            )
            elements[(tag, child.get("id") if tag == "endpoint" else command)] = child
    menus, entries = [], {}
    for suite in admission.get("suites") or []:
        menus += suite.get("menus") or []
        for entry in suite.get("entries") or []:
            entries[entry["command"]] = entry
    return _Suite(root, strings, readings, hole, elements, menus, entries)


def _literal(reading, hole):
    """The one string Core reads a value as, or None when it can be other strings or none."""
    if not isinstance(reading, dict) or "error" in reading or reading.get("truncated"):
        return None
    strings = reading.get("strings") or []
    return strings[0] if len(strings) == 1 and hole not in strings[0] else None


def _owned(suite, placed, xmlns_of):
    """What of the suite each Nova entity owns, by Core's parse: ``{entity: [element]}``, and each owner's ids.

    ``placed`` is the wire placement (module uuid -> index, form uuid -> (m, f)), ``xmlns_of`` each form's
    data namespace in this archive. A form owns its entry (Core reads its ``xmlns``); a module its menu (Core
    lists its forms' commands under it; a menu listing none is placed by its order among such menus and the
    modules holding no form), the view entries and remote requests its menu lists, every remote request a
    stack step of what it owns opens (as Core reads the step's value: a case list's search action), and the
    details it emits (``_claim_details``); an endpoint is the entity's whose command its stack opens last,
    with the remote requests its stack opens. A menu, endpoint or remote request no entity owns is the
    app's. An element no runtime reads (``unread``) is left out here, and placed once both archives are
    read (``_place_unread``). Returns ``(owned, ids)``:
    ``ids[entity]`` holds a form's ``commands``, and a module's ``menus`` (Core's), ``views`` and
    ``remotes`` (commands), in order.
    """
    placed_modules, placed_forms = placed
    module_at = {m: uuid for uuid, m in placed_modules.items()}
    form_of = {xmlns: uuid for uuid, xmlns in xmlns_of.items() if xmlns}
    owned, ids, command_form = {}, {}, {}
    for command, entry in sorted(suite.entries.items()):
        uuid = form_of.get(entry.get("xmlns"))
        if uuid is not None and ("entry", command) in suite.elements:
            command_form[command] = uuid
            ids.setdefault(("form", uuid), {"commands": []})["commands"].append(command)
            owned.setdefault(("form", uuid), []).append(suite.elements[("entry", command)])
    formless, unowned = [], []
    for menu in suite.menus:
        modules = {module_at[placed_forms[command_form[c]][0]] for c in menu["commands"] if c in command_form}
        if len(modules) == 1:
            ids.setdefault(("module", modules.pop()), {}).setdefault("menus", []).append(menu)
        elif modules:
            unowned.append(menu)
        else:
            formless.append(menu)
    formless_modules = [
        uuid
        for uuid, m in sorted(placed_modules.items(), key=lambda item: item[1])
        if not any(at[0] == m for at in placed_forms.values())
    ]
    if len(formless) == len(formless_modules):
        for menu, uuid in zip(formless, formless_modules, strict=True):
            ids.setdefault(("module", uuid), {}).setdefault("menus", []).append(menu)
    else:
        unowned += formless
    remotes = {command for (tag, command) in suite.elements if tag == "remote-request"}
    taken = set()
    for entity in sorted((e for e in ids if e[0] == "module"), key=str):
        held = ids[entity]
        held.setdefault("views", [])
        held.setdefault("remotes", [])
        elements = owned.setdefault(entity, [])
        for menu in held["menus"]:
            elements.append(suite.elements[("menu", menu["id"])])
            for command in menu["commands"]:
                if command in command_form:
                    continue
                if command in remotes:
                    held["remotes"].append(command)
                    taken.add(command)
                    elements.append(suite.elements[("remote-request", command)])
                elif ("entry", command) in suite.elements:
                    # An entry that opens no form (a case list's view) is its menu's.
                    held["views"].append(command)
                    elements.append(suite.elements[("entry", command)])
    _claim_details(suite, owned, ids, placed, remotes, taken)
    app = [suite.elements[("menu", menu["id"])] for menu in unowned if ("menu", menu["id"]) in suite.elements]
    commands = {command: entity for entity, held in ids.items() for command in held.get("commands", [])}
    menus = {menu["id"]: entity for entity, held in ids.items() for menu in held.get("menus", [])}
    # An endpoint is the entity's whose command its stack opens last, with every remote request its stack
    # opens (an entry point's claim).
    for (tag, _), element in sorted(suite.elements.items(), key=lambda item: str(item[0])):
        if tag != "endpoint":
            continue
        owner = _endpoint_owner(element, suite, commands, menus)
        held = app if owner is None else owned.setdefault(owner, [])
        held.append(element)
        for command in _opened(element, suite):
            if command in remotes and command not in taken:
                taken.add(command)
                held.append(suite.elements[("remote-request", command)])
    claimed = {id(element) for elements in owned.values() for element in elements}
    unreached = set(unread(suite))
    for entity, elements in owned.items():
        owned[entity] = [element for element in elements if _key(element) not in unreached]
    app += [
        element
        for (tag, key), element in sorted(suite.elements.items(), key=lambda item: str(item[0]))
        if tag in ("detail", "entry", "remote-request") and (tag, key) not in unreached and id(element) not in claimed
    ]
    if app:
        owned.setdefault((APP, None), []).extend(app)
    return owned, ids


def unread(suite):
    """The suite's details, entries and remote requests no runtime reads, as ``(tag, id)``.

    A runtime reaches a suite element only from a menu (Core's menus, each a
    root of the home screen's tree) or an endpoint: a menu's commands open
    entries and remote requests, a stack step opens the command Core reads its
    value as, and a datum names the details shown for it (commcare-core
    ``CommCarePlatform.getDetail`` and ``CommCareSession.getDetail`` are
    called with a datum's detail ids, as commcare-android's detail screens and
    formplayer's ``MenuSessionRunnerService`` are). What none of these reaches
    is read by nothing (a case list's details where no datum selects a case,
    and the search its action would open).
    """
    by_command = {key: el for (tag, key), el in suite.elements.items() if tag in ("entry", "remote-request")}
    details = {key: el for (tag, key), el in suite.elements.items() if tag == "detail"}
    commands_of = {menu["id"]: list(menu["commands"]) for menu in suite.menus}
    frontier = [
        el for (tag, key), el in suite.elements.items() if tag == "endpoint" or (tag == "menu" and key in commands_of)
    ]
    reached = set()
    while frontier:
        element = frontier.pop()
        if id(element) in reached:
            continue
        reached.add(id(element))
        commands = commands_of.get(element.get("id"), []) if qname(element.tag)[1] == "menu" else []
        for command in commands + _opened(element, suite):
            if command in by_command:
                frontier.append(by_command[command])
        frontier += [details[detail] for detail in _named_details(element) if detail in details]
    return sorted(
        (tag, key)
        for (tag, key), element in suite.elements.items()
        if tag in ("detail", "entry", "remote-request") and id(element) not in reached
    )


def _key(element):
    """An owned element's ``(tag, id)`` as ``_Suite.elements`` keys it."""
    tag = qname(element.tag)[1]
    if tag in ("detail", "menu", "endpoint"):
        return (tag, element.get("id"))
    return (tag, next((c.get("id") for c in element if isinstance(c.tag, str) and qname(c.tag)[1] == "command"), None))


def _opened(element, suite):
    """Every command a stack step in ``element`` opens, as Core reads the step's value."""
    found = []
    for node in element.iter("command"):
        literal = _literal(suite.readings.get(node.get("value")), suite.hole) if node.get("value") else None
        if literal is not None and literal not in found:
            found.append(literal)
    return found


def _claim_details(suite, owned, ids, placed, remotes, taken):
    """Give each module the details it emits, and the remote requests its own elements open.

    A module emits the details its own case selection names: the last datum
    naming a detail in an entry of its forms, views or remote requests. A
    detail no module names so is the one module's that names it at all (a
    search's results, named before the case it selects); any other naming (a
    parent's selection, by a module selecting under it) refers to another
    module's detail, by id. A remote request a stack step of a module's own
    elements opens (a case list's search action) is the module's, with the
    details it names.
    """
    placed_modules, placed_forms = placed
    modules = sorted((e for e in ids if e[0] == "module"), key=str)
    selecting = {}
    for entity in modules:
        held = ids[entity]
        elements = [suite.elements[("entry", command)] for command in held["views"]]
        elements += [suite.elements[("remote-request", command)] for command in held["remotes"]]
        for form, form_held in ids.items():
            if form[0] == "form" and placed_forms[form[1]][0] == placed_modules[entity[1]]:
                elements += [suite.elements[("entry", command)] for command in form_held["commands"]]
        selecting[entity] = elements
    claimed = set()
    while True:
        own = {e: {d for element in selecting[e] for d in _own_details(element)} for e in modules}
        named = {e: {d for element in selecting[e] for d in _named_details(element)} for e in modules}
        added = False
        for (tag, detail), element in sorted(suite.elements.items(), key=lambda item: str(item[0])):
            if tag != "detail" or detail in claimed:
                continue
            owners = [e for e in modules if detail in own[e]] or [e for e in modules if detail in named[e]]
            if len(owners) == 1:
                claimed.add(detail)
                owned[owners[0]].append(element)
                added = True
        for entity in modules:
            for element in list(owned[entity]):
                for command in _opened(element, suite):
                    if command in remotes and command not in taken:
                        taken.add(command)
                        ids[entity]["remotes"].append(command)
                        remote = suite.elements[("remote-request", command)]
                        owned[entity].append(remote)
                        selecting[entity].append(remote)
                        added = True
        if not added:
            return


def _named_details(element):
    """Every detail a datum in ``element`` names."""
    found = []
    for node in element.iter():
        if isinstance(node.tag, str):
            for attribute in DETAIL_REFERENCES:
                if node.get(attribute) and node.get(attribute) not in found:
                    found.append(node.get(attribute))
    return found


def _own_details(element):
    """The details the last datum of ``element`` that names any names: the case it selects for its own module."""
    last = None
    for node in element.iter():
        if isinstance(node.tag, str) and any(node.get(attribute) for attribute in DETAIL_REFERENCES):
            last = node
    return [] if last is None else [last.get(a) for a in DETAIL_REFERENCES if last.get(a)]


def _endpoint_owner(endpoint, suite, commands, menus):
    """The entity whose command the endpoint's stack opens last, as Core reads its steps; None for none."""
    owner = None
    for node in endpoint.iter("command"):
        literal = _literal(suite.readings.get(node.get("value")), suite.hole)
        if literal in commands:
            owner = commands[literal]
        elif literal in menus:
            owner = menus[literal]
    return owner


def _relative_paths(element):
    """Each ``locale`` element's id under ``element``, by its path of (tag, position) steps from it."""
    found = {}

    def walk(node, path):
        counts = {}
        for child in node:
            if not isinstance(child.tag, str):
                continue
            tag = qname(child.tag)[1]
            counts[tag] = counts.get(tag, 0) + 1
            step = (*path, (tag, counts[tag]))
            if tag == "locale" and child.get("id") is not None:
                found[step] = child.get("id")
            walk(child, step)

    walk(element, ())
    return found


def _pairs(before, after, ids_before, ids_after, owned_before, owned_after, xmlns_pairs):
    """D''s positional ids mapped to D's, from the entities both hold (``_owned``)."""
    mapping = dict(xmlns_pairs)
    paired_elements = []
    for entity in set(ids_before) & set(ids_after):
        held_before, held_after = ids_before[entity], ids_after[entity]
        for key in ("commands", "views", "remotes"):
            for command_after, command_before in zip(held_after.get(key, []), held_before.get(key, []), strict=False):
                mapping[command_after] = command_before
        for menu_after, menu_before in zip(held_after.get("menus", []), held_before.get("menus", []), strict=False):
            mapping[menu_after["id"]] = menu_before["id"]
    for entity in set(owned_before) & set(owned_after):
        for element_after, element_before in zip(owned_after[entity], owned_before[entity], strict=False):
            if qname(element_after.tag)[1] != qname(element_before.tag)[1]:
                continue
            paired_elements.append((element_before, element_after))
            # A detail is D's when the datum of the same id names it in the paired element.
            datums_before = {
                node.get("id"): node
                for node in element_before.iter()
                if isinstance(node.tag, str) and any(node.get(attribute) for attribute in DETAIL_REFERENCES)
            }
            for node in element_after.iter():
                if not isinstance(node.tag, str) or node.get("id") not in datums_before:
                    continue
                for attribute in DETAIL_REFERENCES:
                    named_after, named_before = node.get(attribute), datums_before[node.get("id")].get(attribute)
                    if named_after and named_before:
                        mapping.setdefault(named_after, named_before)
    for element_before, element_after in paired_elements:
        locales_before = _relative_paths(element_before)
        for path, key in _relative_paths(element_after).items():
            if path in locales_before:
                mapping.setdefault(key, locales_before[path])
    return mapping


def _is_stack_step(element):
    frame = element.getparent()
    stack = frame.getparent() if frame is not None else None
    return stack is not None and qname(stack.tag)[1] == "stack" and qname(frame.tag)[1] in ("create", "push", "clear")


def _return_menu_identity(value, mapping):
    """Align only the menu reference in Nova's no-matches return guard.

    HQ ``WorkflowHelper.get_if_clause`` compares ``session/data/return_to`` with the offered menu's command;
    Core ``StackOperation.isOperationTriggered`` evaluates it as XPath. Other literals remain authored data. Read
    the exact guard shape with the Core-checked lexer, not text substitution, and preserve every other byte.
    """
    path = "instance('commcaresession')/session/data/return_to"
    prefix = tokens(f"count({path}) = 1 and {path} =")
    read = tokens(value)
    if read is None or len(read) != len(prefix) + 1 or read[-1].kind != "STR":
        return value

    def key(token):
        return token.kind, token.text[1:-1] if token.kind == "STR" else token.text

    if [key(token) for token in read[:-1]] != [key(token) for token in prefix]:
        return value
    literal = read[-1].text
    target = mapping.get(literal[1:-1])
    if target is None or literal[0] in target:
        return value
    end = len(value.rstrip())
    return value[: end - len(literal)] + literal[0] + target + literal[0] + value[end:]


def _as_read(element, suite, mapping):
    """A copy of ``element`` as proof 5 compares it: each stack step value Core reads as one string written as
    that string, and every value ``mapping`` names (D''s ids) as D's."""
    import copy

    copied = copy.deepcopy(element)
    for node in copied.iter():
        if not isinstance(node.tag, str):
            continue
        for attribute, value in list(node.attrib.items()):
            if attribute == "if" and qname(node.tag)[1] == "create":
                parent = node.getparent()
                if parent is not None and qname(parent.tag)[1] == "stack":
                    node.set(attribute, _return_menu_identity(value, mapping))
                    continue
            if attribute == "value" and _is_stack_step(node):
                literal = _literal(suite.readings.get(value), suite.hole)
                if literal is not None:
                    node.set(attribute, READ_AS + mapping.get(literal, literal))
                    continue
            if value in mapping:
                node.set(attribute, mapping[value])
        text = (node.text or "").strip()
        if text and text in mapping:
            node.text = node.text.replace(text, mapping[text])
    return copied


def _suite_record(elements, suite, mapping):
    """One entity's part of the suite (its elements, read as ``_as_read``) and of the app strings they name."""
    root = etree.Element("suite")
    keys = []
    for element in elements:
        read = _as_read(element, suite, mapping)
        root.append(read)
        for node in read.iter("locale"):
            if node.get("id") is not None and node.get("id") not in keys:
                keys.append(node.get("id"))
    reverse = {value: key for key, value in mapping.items()}
    strings = {
        language: {key: held[reverse.get(key, key)] for key in keys if reverse.get(key, key) in held}
        for language, held in sorted(suite.strings.items())
    }
    canonical = [canonical_xml(root), _canonical_json(strings)]
    return Record("suite", (root, strings), digest(canonical))


def _position(entity, placement):
    """An entity's position on one side's wire, or None where that side does not place it."""
    placed_modules, placed_forms = placement
    if entity[0] == "module":
        return placed_modules.get(entity[1])
    if entity[0] == "form":
        return placed_forms.get(entity[1])
    return None


def _place_unread(sides, mapping):
    """Each archive's unread elements, placed: ``[({entity: [element]}, [unowned element])]``.

    An element unread in one archive is an entity's where the other archive
    owns the element of the same name (D''s name mapped to D's, as every name
    is compared) through an entity at the same position in both: positional
    names then name the same entity's element on both sides. Every other is
    unowned (``UNOWNED``).
    """
    reverse = {value: key for key, value in mapping.items()}
    owners = [
        {_key(element): entity for entity, elements in owned.items() for element in elements}
        for (_, _, owned, _, _) in sides
    ]
    found = []
    for index, (suite, placement, _, _, _) in enumerate(sides):
        other = 1 - index
        other_placement = sides[other][1]

        def named(name, index=index):
            # The name the other archive gives this element: D''s names are mapped to D's.
            return mapping.get(name, name) if index == 1 else reverse.get(name, name)

        placed, unowned = {}, []
        for tag, name in unread(suite):
            entity = owners[other].get((tag, named(name)))
            position = None if entity is None else _position(entity, placement)
            if position is not None and position == _position(entity, other_placement):
                placed.setdefault(entity, []).append(suite.elements[(tag, name)])
            else:
                unowned.append(suite.elements[(tag, name)])
        found.append((placed, unowned))
    return found


def _read_out(element, suite, mapping):
    """An unowned element as its record compares it: its own name (a detail's id, an
    entry's or remote request's command id) dropped, each ``locale``'s key replaced by the strings it names
    (a ``string`` child per language that holds the key), the rest as ``_as_read`` reads it."""
    read = _as_read(element, suite, mapping)
    for original, node in zip(element.iter(), read.iter(), strict=True):
        if isinstance(node.tag, str) and qname(node.tag)[1] == "locale" and original.get("id") is not None:
            del node.attrib["id"]
            for language, held in sorted(suite.strings.items()):
                if original.get("id") in held:
                    etree.SubElement(node, "string", language=language).text = held[original.get("id")]
    if qname(read.tag)[1] == "detail":
        read.attrib.pop("id", None)
    for node in read:
        if isinstance(node.tag, str) and qname(node.tag)[1] == "command":
            node.attrib.pop("id", None)
    return read


def _unowned_record(elements, suite, mapping):
    """The record of the unowned elements: each read out (``_read_out``), named by its
    digest so the comparator pairs each with itself whatever its place, in the order of those digests."""
    read = []
    for element in elements:
        copied = _read_out(element, suite, mapping)
        read.append((digest(canonical_xml(copied)), copied))
    root = etree.Element("suite")
    for name, copied in sorted(read, key=lambda item: item[0]):
        copied.set("id", f"unread:{name[:16]}")
        root.append(copied)
    return Record("suite", (root, {}), digest([canonical_xml(root), {}]))


def suite_comparison(document, local, placed, namespaces, *, map_ids=True):
    """The local archives' suites and app strings, by Nova entity (``SUITE`` and ``STRINGS``), D''s ids mapped.

    ``map_ids`` False compares D''s positional ids as they are, which only a control asks for.
    """
    admissions, readings = local.get("admissions") or {}, local.get("stackValues") or {}
    hole = local.get("hole", "")
    sides = []
    for name, path, placement, held in (
        ("local.ccz", document.local_ccz, placed[0], namespaces[0]),
        ("edit/local.ccz", document.edit.local_ccz, placed[1], namespaces[1]),
    ):
        if name not in admissions:
            raise CorpusLayoutError(
                f"The local record holds no admission of {name}, so its suite cannot be read as Core reads it."
            )
        suite = _read_suite(path, admissions[name], readings.get(name) or {}, hole)
        xmlns_of = {entity[1]: value["xmlns"] for entity, value in held.items()}
        owned, ids = _owned(suite, placement, xmlns_of)
        sides.append((suite, placement, owned, ids, xmlns_of))
    (before, placed_before, owned_before, ids_before, xmlns_before) = sides[0]
    (after, placed_after, owned_after, ids_after, xmlns_after) = sides[1]
    xmlns_pairs = {
        xmlns_after[uuid]: xmlns_before[uuid]
        for uuid in set(xmlns_before) & set(xmlns_after)
        if xmlns_before[uuid] and xmlns_after[uuid]
    }
    mapping = _pairs(before, after, ids_before, ids_after, owned_before, owned_after, xmlns_pairs) if map_ids else {}
    unread_placed = _place_unread(sides, mapping)
    unowned = (UNOWNED, tuple(sorted(set(placed_before[0]) | set(placed_after[0]))))
    any_unowned = any(elements for _, elements in unread_placed)
    found, notes = [], {}
    for name, (suite, placement, owned, _, _), mapped, (placed_unread, unowned_elements) in zip(
        ("local.ccz", "edit/local.ccz"), sides, ({}, mapping), unread_placed, strict=True
    ):
        side = Side()
        for entity, elements in placed_unread.items():
            owned.setdefault(entity, []).extend(elements)
        for entity, elements in owned.items():
            side.positions[entity] = _position(entity, placement)
            side.records[entity] = {"suite": _suite_record(elements, suite, mapped)}
        if any_unowned:
            side.positions[unowned] = None
            side.records[unowned] = {"suite": _unowned_record(unowned_elements, suite, mapped)}
        found.append(side)
        holder = {_key(element): f"{entity[0]}:{entity[1]}" for entity, els in placed_unread.items() for element in els}
        notes[name] = [[*key, holder.get(key, UNOWNED)] for key in unread(suite)]
    langs = frozenset(before.strings) | frozenset(after.strings)
    return Comparison("local-suite", found[0], found[1], langs, {"unreadSuiteElements": notes})


# Comparison -----------------------------------------------------------------


def _artifact(name, position):
    if name == "app.json":
        return "app.json"
    prefix = "form" if name == "form" else "local:form"
    return f"{prefix}:{position[0]}.{position[1]}"


def _root(entity, position):
    kind = entity[0]
    if kind == APP:
        return "", ""
    if kind == "module":
        return "/modules/*", f"/modules/{position}"
    return "/modules/*/forms/*", f"/modules/{position[0]}/forms/{position[1]}"


def _suite_differences(document, before, after):
    from proof.checks.compare.app_strings import compare_strings_maps

    (root_before, strings_before), (root_after, strings_after) = before.value, after.value
    found = compare_xml_trees(
        root_before, root_after, check="proof5", document=document, artifact=SUITE, blank_text="exact"
    )
    for language in sorted(set(strings_before) | set(strings_after)):
        found += compare_strings_maps(
            strings_before.get(language, {}),
            strings_after.get(language, {}),
            check="proof5",
            document=document,
            artifact=f"{STRINGS}:{language}",
        )
    return found


def _record_differences(document, entity, name, position, before, after, langs):
    if name == "suite":
        return _suite_differences(document, before, after)
    artifact = _artifact(name, position)
    path, at = _root(entity, position) if name == "app.json" else ("", "")
    if before.kind == "json" and after.kind == "json":
        maps = set(DATA_MAPS)
        _language_maps(before.value, path, langs, maps)
        _language_maps(after.value, path, langs, maps)
        return compare_json(
            before.value,
            after.value,
            check="proof5",
            document=document,
            artifact=artifact,
            data_maps=frozenset(maps),
            root_path=path,
            root_at=at,
        )
    if before.kind == "xml" and after.kind == "xml":
        return compare_xml_trees(
            before.value, after.value, check="proof5", document=document, artifact=artifact, blank_text="exact"
        )

    def shown(record):
        if record.kind == "xml":
            return etree.tostring(record.value, encoding="unicode")
        return record.value

    kind = "removed" if after.kind == "absent" else "added" if before.kind == "absent" else "refused"
    if kind == "refused":
        # One side is not XML (``Record.of_xml``): the cause is the path's last step.
        path, at = f"{path}{NOT_WELL_FORMED}", f"{at}{NOT_WELL_FORMED}"
    return [Difference("proof5", document, artifact, path or "/", at or "/", kind, shown(before), shown(after))]


def _entity_differences(document, entity, before, after, langs):
    """Every difference in one entity both sides hold, per record whose digest changed."""
    found = []
    position = before.positions[entity]
    for name in sorted(set(before.records[entity]) | set(after.records[entity])):
        a, b = before.records[entity][name], after.records[entity][name]
        if a.kind in ("json", "xml", "suite") and a.kind == b.kind:
            if a.digest == b.digest:
                continue
            differences = _record_differences(document, entity, name, position, a, b, langs)
            if not differences:
                raise DigestDisagrees(
                    f"The digest of {entity[0]} {entity[1]}'s {name} record changed on {document}, and the"
                    " comparator found no difference in it: the digest reads something the comparator does"
                    " not. proof/checks/proof5.py's canonical forms must read exactly what proof/checks/compare"
                    " reads."
                )
            found.extend(differences)
        elif a.kind != b.kind or a.value != b.value:
            found.extend(_record_differences(document, entity, name, position, a, b, langs))
    return found


def _presence(document, entity, side, name, kind):
    """One entity only one side holds, outside the footprint."""
    position = side.positions[entity]
    artifact = SUITE if name == "suite" else _artifact(name, position)
    path, at = _root(entity, position) if name == "app.json" else ("/", "/")
    record = side.records[entity][name]
    if record.kind == "suite":
        value = [etree.tostring(record.value[0], encoding="unicode"), record.value[1]]
    else:
        value = etree.tostring(record.value, encoding="unicode") if record.kind == "xml" else record.value
    before, after = (value, None) if kind == "removed" else (None, value)
    return Difference("proof5", document, artifact, path, at, kind, before, after)


@dataclass
class Comparison:
    """Both sides' records of one wire (a configuration's publishes, or the local archives)."""

    name: str
    before: Side
    after: Side
    langs: frozenset
    # What the comparison left apart, for the evidence (the local suites' elements no runtime reads).
    notes: dict = field(default_factory=dict)


def _leftovers(side, replaced, where):
    """Where any of D''s replaced ids is still a value in its compared records."""
    found = []

    def json_values(value, at):
        if isinstance(value, str):
            if value in replaced:
                found.append((at, value))
        elif isinstance(value, list):
            for index, item in enumerate(value):
                json_values(item, f"{at}/{index}")
        elif isinstance(value, dict):
            for key, item in value.items():
                if key in replaced:
                    found.append((f"{at}/{key}", key))
                json_values(item, f"{at}/{key}")

    for entity, records in side.records.items():
        for name, record in records.items():
            if record.kind == "json":
                json_values(record.value, f"{entity[0]}:{entity[1]}:{name}")
            elif record.kind == "xml":
                for element in record.value.iter():
                    if not isinstance(element.tag, str):
                        continue
                    values = [etree.QName(element).namespace, *element.attrib.values()]
                    values += [text for text in (element.text, element.tail) if text]
                    found += [(f"{entity[0]}:{entity[1]}:{name}", value) for value in values if value in replaced]
    if found:
        raise AlignmentIncomplete(
            f"D''s ids remain in what proof 5 compares for {where} after they were mapped to D's: {found[:10]}."
            " proof/observe/alignment.py maps only values equal to an id; look for a reference it did not reach."
        )


def _edit_lacks(document, configuration):
    """What Nova's publish of D' requires that ``configuration`` lacks (decision 19); empty when it would send D'.

    Read from ``edit/verdict.json``'s ``minimumConfiguration`` as ``corpus.Document._publishable`` reads a
    verdict beside an export: the flags it names, and whether case search must be on.
    """
    path = document.edit.root / "verdict.json"
    try:
        verdict = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise CorpusLayoutError(f"The corpus has no {path}, Nova's publish verdict for D'.") from error
    except json.JSONDecodeError as error:
        raise CorpusLayoutError(f"{path} is not JSON ({error}).") from error
    minimum = verdict.get("minimumConfiguration") if isinstance(verdict, dict) else None
    if (
        not isinstance(minimum, dict)
        or not isinstance(minimum.get("flags"), list)
        or not isinstance(minimum.get("caseSearchEnabled"), bool)
    ):
        raise CorpusLayoutError(
            f"{path} holds no minimumConfiguration with its flags and caseSearchEnabled, so it does not say"
            " whether Nova's publish would send D' (decision 19)."
        )
    lacking = sorted(set(minimum["flags"]) - set(configuration.flags))
    if minimum["caseSearchEnabled"] and not configuration.case_search_enabled:
        lacking.append("case search")
    return lacking


def unpublished(document):
    """Each configuration D is published under where Nova's publish refuses D', with what it lacks (decision 19).

    A configuration where Nova would send D' and the corpus holds no update
    is refused: the corpus lost that publish, and skipping it would let
    proof 5 pass having compared nothing there.
    """
    refused = {}
    for name in sorted(document.exports):
        if name in document.edit.exports:
            continue
        lacking = _edit_lacks(document, document.exports[name].configuration)
        if not lacking:
            raise CorpusLayoutError(
                f"D is published under {name!r} ({document.exports[name].directory}), and Nova's publish would send"
                f" D' there too ({document.edit.root / 'verdict.json'}), but {document.edit.root / 'export' / name}"
                " holds no update. The corpus lost D''s publish, so proof 5 cannot compare that configuration."
            )
        refused[name] = lacking
    return refused


def comparisons(document, *, local=None, map_suite_ids=True):
    """Every wire proof 5 compares for one edited document: each configuration's publishes, then the local archives
    (their forms, and with the ``local`` record their suites)."""
    if document.edit is None:
        raise CorpusLayoutError(f"{document.root} has no edit/, so it carries no batch whose locality to prove.")
    layout_before, layout_after = document.wire_modules, document.edit_wire_modules
    placed_before = _placed(layout_before, document.document_path)
    placed_after = _placed(layout_after, document.edit.document_path)
    unpublished(document)
    found = []
    for name in sorted(document.edit.exports):
        if name not in document.exports:
            raise CorpusLayoutError(
                f"{document.edit.root / 'export' / name} is D' published under {name!r}, and D has no export there"
                " to compare it with."
            )
        republish, update = document.exports[name].republish, document.edit.exports[name].update
        json_before, json_after = _app_file(republish), _app_file(update)
        _check_layout(json_before, layout_before, republish.body_path)
        _check_layout(json_after, layout_after, update.body_path)
        ids_before = _ids(json_before, *placed_before)
        ids_after = _ids(json_after, *placed_after)
        alignment = _alignment(ids_before, ids_after)
        positions = {entity: placed_before[1][entity[1]] for entity in ids_before if entity[0] == "form"}
        before = _upload_side(
            json_before,
            placed_before,
            {uuid: _source(json_before, ids_before[("form", uuid)]["unique_id"]) for uuid in placed_before[1]},
            alignment,
            mapped=False,
            artifact_positions=positions,
        )
        after = _upload_side(
            json_after,
            placed_after,
            {uuid: _source(json_after, ids_after[("form", uuid)]["unique_id"]) for uuid in placed_after[1]},
            alignment,
            mapped=True,
            artifact_positions=positions,
        )
        _leftovers(after, set(alignment.value_map()), f"{document.id} under {name}")
        langs = frozenset(json_before.get("langs") or []) | frozenset(json_after.get("langs") or [])
        found.append(Comparison(name, before, after, langs))
    if (document.local_ccz is None) != (document.edit.local_ccz is None):
        held, lost = (
            (document.local_ccz, document.edit.root / "local.ccz")
            if document.edit.local_ccz is None
            else (document.edit.local_ccz, document.root / "local.ccz")
        )
        raise CorpusLayoutError(
            f"{held} is one side's local export and {lost} does not exist, so the local archives of D and D'"
            " cannot be compared. The corpus writes both (proof/corpus/entryWriter.ts)."
        )
    if document.local_ccz is not None:
        sources_before = _local_sources(document.local_ccz, placed_before[1])
        sources_after = _local_sources(document.edit.local_ccz, placed_after[1])

        def namespaces(sources, placed_forms):
            return {("form", uuid): {"xmlns": data_namespace(sources[uuid])} for uuid in placed_forms}

        ids_before = namespaces(sources_before, placed_before[1])
        ids_after = namespaces(sources_after, placed_after[1])
        alignment = _alignment(ids_before, ids_after)
        positions = {entity: placed_before[1][entity[1]] for entity in ids_before}
        before = _local_side(
            sources_before, alignment, mapped=False, artifact_positions=positions, placed_forms=placed_before[1]
        )
        after = _local_side(
            sources_after, alignment, mapped=True, artifact_positions=positions, placed_forms=placed_after[1]
        )
        _leftovers(after, set(alignment.value_map()), f"{document.id}'s local archives")
        found.append(Comparison("local", before, after, frozenset()))
        if local is not None:
            found.append(
                suite_comparison(
                    document,
                    local,
                    (placed_before, placed_after),
                    (ids_before, ids_after),
                    map_ids=map_suite_ids,
                )
            )
    if not found:
        raise CorpusLayoutError(
            f"{document.root} holds no publish of D' beside one of D, and no local archives, so proof 5 would"
            " compare nothing for its edit batch."
        )
    return found


def by_entity(document_id, compared, footprint: Footprint | None):
    """Every difference in an entity outside ``footprint`` (every entity, when it is None), by entity."""
    found = {}
    for comparison in compared:
        before, after = comparison.before, comparison.after
        for entity in sorted(set(before.records) | set(after.records), key=str):
            if footprint is not None and footprint.holds(entity):
                continue
            if entity not in after.records:
                differences = [_presence(document_id, entity, before, n, "removed") for n in before.records[entity]]
            elif entity not in before.records:
                differences = [_presence(document_id, entity, after, n, "added") for n in after.records[entity]]
            else:
                differences = _entity_differences(document_id, entity, before, after, comparison.langs)
            if differences:
                found.setdefault(entity, []).extend(differences)
    return {entity: _distinct(differences) for entity, differences in found.items()}


def _distinct(differences):
    """The differences without repeats (two configurations often emit the same wire)."""
    seen, kept = set(), []
    for difference in differences:
        key = json.dumps(difference.as_json(), sort_keys=True, default=str)
        if key not in seen:
            seen.add(key)
            kept.append(difference)
    return kept


def entity_changes(document_id, compared):
    """Every entity whose wire changed between D and D', inside the footprint or not."""
    return set(by_entity(document_id, compared, None))


def locality(document, footprint: Footprint | None = None, *, local=None):
    """Proof 5 on one edited document: every difference in an entity outside the batch's footprint.

    ``local`` is the document's ``local`` record (Core's parse of each local
    archive), without which the local suite is not compared. Returns the
    differences and what was compared: the configurations, those where Nova's
    publish refuses D' with what each lacks (``refused``), whether the local
    archives were, whether their suites were, and how many entities of each
    kind were outside the footprint.
    """
    footprint = footprint_of(document) if footprint is None else footprint
    compared = comparisons(document, local=local)
    differences = [d for found in by_entity(document.id, compared, footprint).values() for d in found]
    outside = {
        entity
        for comparison in compared
        for entity in set(comparison.before.records) & set(comparison.after.records)
        if not footprint.holds(entity)
    }
    summary = {
        "configurations": [comparison.name for comparison in compared if not comparison.name.startswith("local")],
        "refused": unpublished(document),
        "local": any(comparison.name == "local" for comparison in compared),
        "localSuite": any(comparison.name == "local-suite" for comparison in compared),
        **{key: value for comparison in compared for key, value in comparison.notes.items()},
        "outside": {
            "app": (APP, None) in outside,
            "modules": sum(1 for entity in outside if entity[0] == "module"),
            "forms": sum(1 for entity in outside if entity[0] == "form"),
        },
    }
    return differences, summary
