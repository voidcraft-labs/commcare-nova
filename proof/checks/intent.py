"""Intent checks (decision 16): what HQ builds and what Core runs, against what the Nova document states.

A comparison of two builds cannot see a defect both share, so these checks
hold HQ's state and Core's runtime to the document itself. The expected
values are read from the document (``document.json``'s ``doc``, Nova's
persisted blueprint; a control retains the intent itself, ``intent_of``),
never from Nova's emitter or evaluator; the observed
ones from the document's records: HQ's state after Nova's publish (A, B, and
B-edit for D': the stored app, its identities and its build), the data
dictionary HQ's saves wrote and Core's parse of each form HQ built and of
each form of Nova's local ``.ccz`` (``proof.observe.intent``). This module
judges the records alone, and imports neither HQ nor Django.

On every corpus document the checks are structural:

- **HQ, each module's case type**: the case type HQ holds for the module at
  each position of the wire layout (``app.json@<state>``,
  ``/modules/*/case_type``) is the document's ``caseType`` for that module
  (``''`` where it names none; a synthetic module, which holds a form Nova
  places outside its host, has its host's).
- **HQ, the case properties it learns**: for each form, the custom
  properties the document writes per case type (each field's ``caseWrite``
  and each case operation's ``writes``) are the properties HQ learns the
  form writes (``FormBase.get_all_case_updates``, kept as the identity
  record's ``case_updates``; ``form:<m>.<f>@<state>``, ``/case_updates/*/*``).
  HQ names an attachment property ``attachment:<name>`` under
  ``MM_CASE_PROPERTIES`` (``Form.get_case_property_name_formatter``,
  ``const.ATTACHMENT_PREFIX``), which is read as ``<name>``.
- **HQ, the data dictionary**: each custom property the document writes in a
  slot HQ's save reads is a row HQ's save wrote for its case type
  (``tasks.py::_refresh_data_dictionary_from_app``; ``data_dictionary@<state>``,
  ``/*/*``). Rows accumulate over saves, so only a missing row is a
  difference. The refresh reads three slots, and each write is held to the
  slot HQ's own editors give it (``expected_dictionary``):

  - a form's updates of its menu's case and of the worker's own case
    (``actions.update_case``, ``actions.usercase_update``), only in a menu
    that names a case type (``if not module.is_surveys``,
    ``ModuleBase.is_surveys``: ``case_type == ''``);
  - Save to Case (``form.get_save_to_case_updates``, the form's
    ``case_references_data.save``), only under ``VELLUM_SAVE_TO_CASE``
    (``domain_has_privilege``), for every form of every menu, merged with
    ``dict.update``, so for each case type only the last form (in app order)
    that writes it there counts. Save to Case is where HQ's editors put what
    Case Management cannot say: a case operation, and an update of the
    selected cases in a multi-select menu (HQ builds a form there that opens
    no case without its case management, ``xform.py::XForm._create_casexml``:
    ``default_case_management = False`` for ``is_multi_select()``, while the
    worker's own case is ``_add_usercase``'s, in any menu);
  - an advanced form's ``load_update_cases``, which Nova does not emit.

  A child or extension case a form creates (``actions.subcases``) is a slot
  the refresh never reads, so its writes are not expected there; HQ learns
  them all the same (``get_all_case_updates``, above).
- **HQ, each attachment path**: each write the document stores as a case
  attachment (``caseWrite.mode`` ``attachment``) is an ``attachment`` child
  of a case block of that type in the form HQ built
  (``xform.py::CaseBlock.add_case_updates``), and HQ builds no attachment the
  document does not store as one (``form:<m>.<f>@<state>``, ``/attachments/*/*``),
  read through Core's parse of the form as below.
- **HQ, the profile**: the profile HQ built requires the CommCare version the
  configuration publishes at (``requiredMajor``, ``requiredMinor``,
  ``requiredMinimal``, from the app's build spec), carries the document's
  app name, and sets each setting of HQ's settings file as HQ does for an app
  that states none, since a Nova document states no app settings
  (``Application.create_profile``: a setting the app does not set is
  written only where its ``commcare_default`` differs from its ``default``,
  with the default); ``profile.ccpr@<state>``.
- **HQ, each search's CSQL**: every CSQL string build(A)'s searches send in
  proof 3's sessions (each request's ``_xpath_query``), compiled by HQ's case
  search compiler in a case search's context under the configuration's flags
  (``build_filter_from_xpath``, ``proof.observe.sessions.search_compiles``),
  compiles: a refusal is ``csql@A``,
  ``/*/raised/<exception class>/<where HQ raised it>`` (``search_compiles``),
  so HQ refusing an ordering on a time and a related case lookup without its
  flag are two classes.
- **Core, on what HQ built** (Core's own parse of each form HQ built, the
  runner's ``formShape`` op; ``core:form:<m>.<f>@<state>``): each case the
  document says the form creates is a case block whose ``case_type`` is
  that type (``/creates/*``), each custom property the document writes is
  an element of a case block of that type (``/writes/*/*``), and each field
  the document validates has a constraint Core holds at its node
  (``/constraints/*``).
- **Core, on Nova's local ``.ccz``**: each validated field's constraint, the
  same way, on each archive by its own name (``core:local.ccz/form:<m>.<f>``,
  ``core:local-again.ccz/…``, ``core:edit/local.ccz/…``).

Properties are custom ones: the standard properties (``case_name``,
``owner_id``, ``external_id`` and the rest of
``lib/domain/standardCaseProperties.ts``) are case columns HQ keeps through
its own action slots, outside the update map these checks read, and a
parent path (``parent/<name>``) is another case's property.

A form's data node is the field's path in the document's tree: the field's
id under each of its containers' ids (groups, repeats and sections are each
an element of the form's data, and a query-bound repeat's rows are its
``item`` children, CommCare's model iteration).

On a targeted document (one with ``expected.json``), value-level checks run
too: each expectation names an export (``local``, or ``A`` or ``B`` for HQ's
build under a configuration, ``minimum`` unless it names one), a form of the
document by its Nova uuid, the request Core's ``evaluate`` op runs there
(answers, constraint checks, expressions, instances, a session and a
restore), and the values it must produce, each at a JSON Pointer into Core's
result. Expected values are fixed by hand from the document's authored
meaning::

    {"intent": [{"id": "...", "export": "local", "configuration": "minimum",
                 "form": "<form uuid>", "restore": "<file in the document's directory>",
                 "request": {...}, "expect": [{"pointer": "/constraints/0/result", "value": "constraint"}]}]}

Where Core raised on what the check reads, the records hold what it said.
A form Core's parser refused is the bar's to report: the bar holds Core's
admission of the same build or archive, which parses every form the same
way (``admission@<state>``, ``admission@local.ccz``), so every structural
check leaves that form out and reports nothing more for it, and so does
an expectation whose request runs in it. Where Core's evaluate raised on
an expectation's request in a form Core parses, or in a case list, the
check stops with it (``CoreRaised``): the observation was made, and there
is nothing to compare. An expectation that cannot run because HQ
built nothing (a refused publish or a failed build) or Core did not admit
the local archive is the bar's to report (``import@<state>``,
``<step>@<state>``, ``admission@local.ccz``), and nothing more is reported
for it; one whose form HQ's build does not hold is refused at
``/no-form-file``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from lxml import etree

from proof.checks import observations
from proof.checks.corpus import CorpusLayoutError
from proof.checks.differences import Difference, pointer_token
from proof.observe.intent import DEFAULT_CONFIGURATION, expectations, form_file, form_position
from proof.observe.outcome import outcome_from_record

CASE_XMLNS = "http://commcarehq.org/case/transaction/v2"
ATTACHMENT_PREFIX = "attachment:"  # commcare-hq corehq/apps/app_manager/const.py::ATTACHMENT_PREFIX
# lib/domain/standardCaseProperties.ts::STANDARD_CASE_LIST_PROPERTY_DATA_TYPES, and HQ's own name for the case
# name in its update map (xform.py::CaseBlock.add_case_updates writes "name" as case_name), which Nova refuses as
# an authored property name (lib/domain/casePropertyName.ts).
STANDARD_PROPERTIES = frozenset(
    {"case_id", "case_name", "date_opened", "last_modified", "owner_id", "external_id", "status", "name"}
)
CONTAINER_KINDS = frozenset({"group", "repeat", "section"})
# The worker's own case, which a form writes and nothing creates (lib/domain/usercase.ts::USERCASE_CASE_TYPE;
# HQ's app_manager/const.py::USERCASE_TYPE).
USERCASE_TYPE = "commcare-user"


def _custom(prop):
    return isinstance(prop, str) and prop not in STANDARD_PROPERTIES and "/" not in prop


# What the document states ------------------------------------------------------


@dataclass
class FormIntent:
    """What the document says one form does."""

    uuid: str
    module_type: str | None
    writes: dict = field(default_factory=dict)  # case type -> {property: mode}, every write below
    creates: set = field(default_factory=set)  # case types the form creates
    validations: dict = field(default_factory=dict)  # field uuid -> data path below the data root
    form_type: str | None = None
    multiple: bool = False  # the menu HQ holds the form in selects several cases
    field_writes: dict = field(default_factory=dict)  # case type -> {property: mode}, from fields' caseWrite
    operation_writes: dict = field(default_factory=dict)  # case type -> {property}, from case operations


@dataclass
class Intent:
    """What the document states that HQ and Core must hold: per wire position, its modules and forms."""

    app_name: str
    modules: list  # [(case type or "", [FormIntent])] in wire order


def _field_paths(doc, form_uuid):
    """Each field under a form, with its data path below the data root (its containers' ids, then its own)."""
    order = doc.get("fieldOrder") or {}
    fields = doc.get("fields") or {}
    found = []

    def walk(parent, prefix):
        for uuid in order.get(parent, []):
            item = fields.get(uuid)
            if item is None:
                raise CorpusLayoutError(f"The document's fieldOrder names the field {uuid}, which it does not hold.")
            path = f"{prefix}/{item['id']}"
            found.append((uuid, item, path))
            if item.get("kind") in CONTAINER_KINDS:
                # A query-bound repeat is CommCare's model iteration, whose rows are the repeat's <item>
                # children (Vellum src/modeliteration.js, the row node's id "item").
                query = item.get("kind") == "repeat" and item.get("repeat_mode") == "query_bound"
                walk(uuid, f"{path}/item" if query else path)

    walk(form_uuid, "")
    return found


def document_intent(document_json) -> Intent:
    """The intent the document states, placed by the wire layout ``document.json`` records."""
    doc = document_json.get("doc") if isinstance(document_json, dict) else None
    wire = (document_json.get("wire") or {}).get("modules") if isinstance(document_json, dict) else None
    if not isinstance(doc, dict) or not isinstance(wire, list):
        raise CorpusLayoutError("document.json holds no doc and wire.modules, so the document's intent is unreadable.")
    modules = doc.get("modules") or {}
    forms = doc.get("forms") or {}
    module_of = {f: m for m, members in (doc.get("formOrder") or {}).items() for f in members}
    placed = []
    for wire_module in wire:
        synthetic = wire_module.get("synthetic")
        host = synthetic.get("hostModuleUuid") if isinstance(synthetic, dict) else wire_module["uuid"]
        module = modules.get(host)
        if module is None:
            raise CorpusLayoutError(f"The wire layout places the module {host}, which the document does not hold.")
        case_type = module.get("caseType") or ""
        # A synthetic module holds one form outside its host's case list, so it selects nothing itself.
        selection = (module.get("caseListConfig") or {}).get("selection") or {}
        multiple = not isinstance(synthetic, dict) and selection.get("kind") == "multiple"
        intents = []
        for form_uuid in wire_module["forms"]:
            form = forms.get(form_uuid)
            if form is None:
                raise CorpusLayoutError(
                    f"The wire layout places the form {form_uuid}, which the document does not hold."
                )
            owner = modules.get(module_of.get(form_uuid)) or module
            intents.append(_form_intent(doc, form_uuid, form, owner.get("caseType"), multiple))
        placed.append((case_type, intents))
    return Intent(app_name=doc.get("appName") or "", modules=placed)


def intent_json(intent: Intent) -> dict:
    """The intent as JSON, as a control retains it (``proof.checks.controls``), sets as sorted lists."""

    def form_json(form):
        return {
            "uuid": form.uuid,
            "moduleType": form.module_type,
            "writes": form.writes,
            "creates": sorted(form.creates),
            "validations": form.validations,
            "formType": form.form_type,
            "multiple": form.multiple,
            "fieldWrites": form.field_writes,
            "operationWrites": {case_type: sorted(props) for case_type, props in form.operation_writes.items()},
        }

    return {
        "appName": intent.app_name,
        "modules": [[case_type, [form_json(form) for form in forms]] for case_type, forms in intent.modules],
    }


def intent_from_json(value) -> Intent:
    """The intent a control retains (``intent_json``)."""

    def form_of(held):
        return FormIntent(
            uuid=held["uuid"],
            module_type=held["moduleType"],
            writes=held["writes"],
            creates=set(held["creates"]),
            validations=held["validations"],
            form_type=held["formType"],
            multiple=held["multiple"],
            field_writes=held["fieldWrites"],
            operation_writes={case_type: set(props) for case_type, props in held["operationWrites"].items()},
        )

    return Intent(
        app_name=value["appName"],
        modules=[(case_type, [form_of(form) for form in forms]) for case_type, forms in value["modules"]],
    )


def intent_of(document, *, edit=False) -> Intent:
    """What D (or D', ``edit``) states: read from its ``document.json``, or, for a control, the intent it retains
    (``Document.derived``), so a control's expectations never depend on the shape of Nova's document."""
    held = document.derived("intent", edit=edit)
    if held is not None:
        return intent_from_json(held)
    return document_intent(document.edit_document if edit else document.document)


def _form_intent(doc, uuid, form, module_type, multiple=False):
    intent = FormIntent(uuid=uuid, module_type=module_type, form_type=form.get("type"), multiple=multiple)
    if form.get("type") == "registration" and module_type:
        intent.creates.add(module_type)
    for field_uuid, item, path in _field_paths(doc, uuid):
        write = item.get("caseWrite")
        if isinstance(write, dict) and write.get("caseType") and write.get("property"):
            mode = write.get("mode") or "value"
            if _custom(write["property"]):
                intent.writes.setdefault(write["caseType"], {})[write["property"]] = mode
                intent.field_writes.setdefault(write["caseType"], {})[write["property"]] = mode
            if write["caseType"] not in (module_type, USERCASE_TYPE):
                # Naming a type other than the module's own creates a child case of it (lib/domain/CLAUDE.md,
                # case writes); the worker's own case is only ever updated.
                intent.creates.add(write["caseType"])
        if item.get("validate") is not None:
            intent.validations[field_uuid] = path
    for operation in form.get("caseOperations") or ():
        case_type = operation.get("caseType")
        if operation.get("action") == "create" and case_type:
            intent.creates.add(case_type)
        for write in operation.get("writes") or ():
            if case_type and _custom(write.get("property")):
                intent.writes.setdefault(case_type, {})[write["property"]] = "value"
                intent.operation_writes.setdefault(case_type, set()).add(write["property"])
    return intent


def written_properties(intent: Intent):
    """Every custom property the document writes, by case type."""
    found = {}
    for _, forms in intent.modules:
        for form in forms:
            for case_type, props in form.writes.items():
                found.setdefault(case_type, set()).update(props)
    return found


SAVE_TO_CASE_PRIVILEGE = "VELLUM_SAVE_TO_CASE"  # commcare-hq corehq/privileges.py


def expected_dictionary(intent: Intent, privileges) -> dict:
    """The data dictionary rows HQ's save writes for an app that states the document's writes in HQ's slots.

    ``tasks.py::_refresh_data_dictionary_from_app``, slot by slot (the module
    docstring says which write goes in which): Save to Case first, each
    form's ``{case type: properties}`` merged over the previous ones with
    ``dict.update`` (``case_type_to_prop.update(form.get_save_to_case_updates())``),
    then each case-named menu's updates of its case and the worker's, added.
    """
    save_to_case = {}
    updates = {}
    for case_type, forms in intent.modules:
        for form in forms:
            saved = {t: set(props) for t, props in form.operation_writes.items()}
            for written_type, props in form.field_writes.items():
                if written_type == USERCASE_TYPE:
                    if case_type:
                        updates.setdefault(written_type, set()).update(props)
                elif written_type == case_type and case_type:
                    if form.multiple and form.form_type != "registration":
                        saved.setdefault(written_type, set()).update(props)
                    else:
                        updates.setdefault(written_type, set()).update(props)
            if SAVE_TO_CASE_PRIVILEGE in privileges:
                save_to_case.update(saved)
    rows = {t: set(props) for t, props in save_to_case.items()}
    for written_type, props in updates.items():
        rows.setdefault(written_type, set()).update(props)
    return {t: props for t, props in rows.items() if props}


# Case blocks, from a form's nodes ----------------------------------------------


@dataclass
class CaseBlock:
    path: str
    case_type: str | None  # the create block's case_type, or None for a block that creates nothing
    updates: set
    attachments: set


def case_blocks(nodes):
    """The case blocks of a form's data, from Core's parse of it (the runner's ``formShape`` nodes).

    A block is a ``case`` element in the case transaction namespace; what it
    creates and writes are its ``create/case_type``, ``update/*`` and
    ``attachment/*`` children, as HQ's case processing reads them
    (``casexml/apps/case/xform.py::extract_case_blocks``).
    """
    blocks = {
        node["path"]: CaseBlock(node["path"], None, set(), set())
        for node in nodes
        if node["namespace"] == CASE_XMLNS and node["name"] == "case"
    }
    for node in nodes:
        if node["namespace"] != CASE_XMLNS:
            continue
        owners = [path for path in blocks if node["path"].startswith(path + "/")]
        if not owners:
            continue
        block = blocks[max(owners, key=len)]
        steps = node["path"][len(block.path) + 1 :].split("/")
        if steps == ["create", "case_type"]:
            # Written in the template, or by a calculate Core reads as a constant (a Save to Case block's); any
            # other calculate leaves the type to the submission.
            written = node.get("calculatedConstant") if node.get("calculate") is not None else node["value"]
            block.case_type = (written or "").strip() or None
        elif len(steps) == 2 and steps[0] == "update":
            block.updates.add(steps[1])
        elif len(steps) == 2 and steps[0] == "attachment":
            block.attachments.add(steps[1])
    return list(blocks.values())


# Differences -------------------------------------------------------------------


def _difference(document, artifact, path, at, kind, before, after):
    return Difference("intent", document, artifact, path, at, kind, before, after)


def _set_differences(document, artifact, root, expected, observed, *, report_added=True):
    """``{type: {prop}}`` against ``{type: {prop}}``: one difference per property on one side only."""
    found = []
    for case_type in sorted(set(expected) | set(observed)):
        want, have = expected.get(case_type, set()), observed.get(case_type, set())
        for prop in sorted(want - have):
            at = f"{root}/{pointer_token(case_type)}/{pointer_token(prop)}"
            found.append(_difference(document, artifact, f"{root}/*/*", at, "removed", prop, None))
        if report_added:
            for prop in sorted(have - want):
                at = f"{root}/{pointer_token(case_type)}/{pointer_token(prop)}"
                found.append(_difference(document, artifact, f"{root}/*/*", at, "added", None, prop))
    return found


# What HQ and Core hold, from the records -------------------------------------------


class ObservationMissing(ValueError):
    """The records hold no observation of something the check reads: the observation did not make it."""


class CoreRaised(RuntimeError):
    """Core's evaluate raised on an expectation's request in a form Core parses, or in a case list, and the records
    hold what it said (``proof.observe.intent.core_raised``): the observation was made, and the check cannot judge
    it."""


def _said(raised):
    """What Core said as it raised, as the records hold it, quoted for a message (its class where it gave none)."""
    return f'"{(raised.get("message") or raised["class"]).strip()}"'


@dataclass
class HeldState:
    """One app state HQ held (A, B or B-edit), as its part's record holds it with the intent observation's."""

    name: str
    doc: dict
    identities: dict
    build: object  # proof.observe.outcome.BuildOutcome
    data_dictionary: dict = field(default_factory=dict)
    # Core's parse of each form HQ built, by its file: its nodes, or {"refused": <what Core raised>}.
    shapes: dict = field(default_factory=dict)

    def nodes(self, name, artifact):
        return _nodes(self.shapes, name, artifact)


def _nodes(shapes, name, artifact):
    """Core's parse of one form, from ``shapes``, or None where Core's parser raised on it.

    A form Core's parser refused is left to the bar, which holds Core's
    admission of the build or archive that holds it, parsed the same way
    (XFormInstaller, through XFormUtils.getFormRaw): each caller leaves the
    form out. A form the observation did not parse stops the check, since its
    creates, writes and constraints are then unread.
    """
    shape = shapes.get(name)
    if shape is None:
        raise ObservationMissing(
            f"The records hold no Core parse of {name} ({artifact}), which the intent check reads; the observation"
            " (proof/observe/intent.py) parses every form of every build and archive."
        )
    if isinstance(shape, dict):
        return None
    return shape


def held_state(record, name, blobs):
    """The state a part's record holds (``a``, ``b`` or ``b_edit``), or None where HQ refused its publish."""
    state = (record or {}).get("state")
    if state is None:
        return None
    observed = (record.get("hooks") or {}).get("intent")
    if observed is None:
        raise ObservationMissing(
            f"The record of {name} holds no intent observation (proof/observe/intent.py::observe), so HQ's data"
            " dictionary and Core's parse of its build are unread; it was made without it."
        )
    shapes = {
        file: shape if isinstance(shape, dict) else blobs.get_json(shape) for file, shape in observed["forms"].items()
    }
    return HeldState(
        name,
        blobs.get_json(state["doc"]),
        state["identities"],
        outcome_from_record(state["build"], blobs, name),
        observed["dataDictionary"],
        shapes,
    )


def local_observation(document, records):
    """The intent observation of the local archives (``proof.observe.intent.observe_local``)."""
    observed = ((records.local or {}).get("hooks") or {}).get("intent")
    if observed is None:
        raise ObservationMissing(
            f"The records of {document.id} hold no intent observation in their local part (proof/observe/intent.py::"
            "observe_local), so Core's parse of the local archives is unread; they were made without it."
        )
    return observed


@dataclass(frozen=True)
class JudgedConfiguration:
    """What the judge reads of a configuration: as its ``a`` record holds it."""

    name: str
    commcare_version: str
    privileges: frozenset

    @classmethod
    def of(cls, name, record):
        held = (record or {}).get("configuration")
        if held is None:
            raise ObservationMissing(f"The records hold no {name} configuration (its a part's configuration).")
        return cls(name, held["commcareVersion"], frozenset(held["privileges"]))


# Differences, per state ------------------------------------------------------------


def module_case_types(document, intent: Intent, state) -> list:
    """Each module's case type HQ holds, against the document's."""
    artifact = f"app.json@{state.name}"
    held = state.doc.get("modules") or []
    found = []
    if len(held) != len(intent.modules):
        found.append(_difference(document, artifact, "/modules", "/modules", "changed", len(intent.modules), len(held)))
    for index, ((case_type, _), module) in enumerate(zip(intent.modules, held, strict=False)):
        observed = module.get("case_type") or ""
        if observed != case_type:
            at = f"/modules/{index}/case_type"
            found.append(_difference(document, artifact, "/modules/*/case_type", at, "changed", case_type, observed))
    return found


def _learned(record):
    learned = {}
    for case_type, props in (record.get("case_updates") or {}).items():
        names = {p[len(ATTACHMENT_PREFIX) :] if p.startswith(ATTACHMENT_PREFIX) else p for p in props}
        names = {p for p in names if _custom(p)}
        if names:
            learned[case_type] = names
    return learned


def _forms(intent):
    for m, (_, forms) in enumerate(intent.modules):
        for f, form in enumerate(forms):
            yield f"{m}.{f}", form


def learned_properties(document, intent: Intent, state) -> list:
    """The custom properties HQ learns each form writes, against the document's writes."""
    found = []
    for position, form in _forms(intent):
        record = state.identities.get(f"form:{position}")
        artifact = f"form:{position}@{state.name}"
        if record is None:
            found.append(_difference(document, artifact, "/", "/", "removed", form.uuid, None))
            continue
        expected = {t: set(props) for t, props in form.writes.items()}
        found += _set_differences(document, artifact, "/case_updates", expected, _learned(record))
    return found


def data_dictionary(document, intent: Intent, state, privileges) -> list:
    """Each row HQ's save writes for the document's writes (``expected_dictionary``) is one it wrote."""
    expected = expected_dictionary(intent, privileges)
    observed = {case_type: set(props) for case_type, props in state.data_dictionary.items()}
    return _set_differences(document, f"data_dictionary@{state.name}", "", expected, observed, report_added=False)


def _blocks_hold(blocks, case_type, prop, part):
    """Whether a case block of ``case_type`` holds ``prop`` in ``part`` (updates or attachments).

    A block that creates nothing updates a case whose id it computes, so its
    type is not in the block, and it counts for any type.
    """
    return any(prop in getattr(block, part) and block.case_type in (case_type, None) for block in blocks)


def attachment_paths(document, intent: Intent, state) -> list:
    """Each attachment the document stores is an attachment in the form HQ built, and none other is."""
    found = []
    files = state.build.files or {}
    for position, form in _forms(intent):
        name = form_file(*position.split("."))
        if name not in files:
            continue  # the bar reports a build that wrote no form
        artifact = f"form:{position}@{state.name}"
        nodes = state.nodes(name, artifact)
        if nodes is None:
            continue  # Core's parser refused the form: the bar reports it (admission@<state>)
        blocks = case_blocks(nodes)
        expected = {t: {p for p, mode in props.items() if mode == "attachment"} for t, props in form.writes.items()}
        expected = {t: props for t, props in expected.items() if props}
        for case_type, props in sorted(expected.items()):
            for prop in sorted(props):
                if not _blocks_hold(blocks, case_type, prop, "attachments"):
                    at = f"/attachments/{pointer_token(case_type)}/{pointer_token(prop)}"
                    found.append(_difference(document, artifact, "/attachments/*/*", at, "removed", prop, None))
        wanted = {p for props in expected.values() for p in props}
        for block in blocks:
            for prop in sorted(block.attachments - wanted):
                at = f"/attachments/{pointer_token(block.case_type or '')}/{pointer_token(prop)}"
                found.append(_difference(document, artifact, "/attachments/*/*", at, "added", None, prop))
    return found


def _version_parts(version):
    parts = version.split(".")
    return (parts + ["0", "0", "0"])[:3]


def profile_settings(document, intent: Intent, state, configuration, manifest_items) -> list:
    """The profile HQ built: the configuration's version, the document's name, and HQ's settings for none."""
    artifact = f"profile.ccpr@{state.name}"
    built = (state.build.files or {}).get("profile.ccpr")
    if built is None:
        return []  # the bar reports a build that wrote no profile
    root = etree.fromstring(built, etree.XMLParser(resolve_entities=False, no_network=True))
    found = []
    major, minor, minimal = _version_parts(configuration.commcare_version)
    for attribute, expected in (
        ("requiredMajor", major),
        ("requiredMinor", minor),
        ("requiredMinimal", minimal),
        ("name", intent.app_name),
    ):
        observed = root.get(attribute)
        if observed != expected:
            path = f"/profile/@{attribute}"
            found.append(_difference(document, artifact, path, path, "changed", expected, observed))
    properties = {
        element.get("key"): element.get("value")
        for element in root.iter()
        if isinstance(element.tag, str) and etree.QName(element).localname == "property"
    }
    for key, item in sorted(manifest_items.items()):
        if not key.startswith("setting:properties."):
            continue
        name = key[len("setting:properties.") :]
        expected = _unstated_setting(item)
        observed = properties.get(name)
        if observed != expected:
            path = f"/profile/property[@key={name}]/@value"
            found.append(_difference(document, artifact, path, path, "changed", expected, observed))
    return found


def _unstated_setting(item):
    """What ``Application.create_profile`` writes for a profile property the app does not set."""
    if "commcare_default" in item and item["commcare_default"] != item.get("default"):
        default = item.get("default")
        return default if default else None
    return None


# Core --------------------------------------------------------------------------


def _node_at(nodes, path):
    """The node whose path below the data root is ``path``."""
    for node in nodes:
        below = "/" + "/".join(node["path"].split("/")[2:])
        if below == path:
            return node
    return None


def core_form(document, form: FormIntent, nodes, artifact, *, cases=True) -> list:
    """Core's parse of one form against the document: its creates, its writes and its validations."""
    found = []
    if cases:
        blocks = case_blocks(nodes)
        created = {block.case_type for block in blocks if block.case_type}
        for case_type in sorted(form.creates - created):
            at = f"/creates/{pointer_token(case_type)}"
            found.append(_difference(document, artifact, "/creates/*", at, "removed", case_type, None))
        for case_type in sorted(created - form.creates):
            at = f"/creates/{pointer_token(case_type)}"
            found.append(_difference(document, artifact, "/creates/*", at, "added", None, case_type))
        for case_type, props in sorted(form.writes.items()):
            for prop, mode in sorted(props.items()):
                part = "attachments" if mode == "attachment" else "updates"
                if not _blocks_hold(blocks, case_type, prop, part):
                    at = f"/writes/{pointer_token(case_type)}/{pointer_token(prop)}"
                    found.append(_difference(document, artifact, "/writes/*/*", at, "removed", prop, None))
    for path in sorted(form.validations.values()):
        node = _node_at(nodes, path)
        at = f"/constraints{path}"
        if node is None:
            found.append(_difference(document, artifact, "/constraints/*", at, "removed", path, "no node"))
        elif node.get("constraint") is None:
            found.append(_difference(document, artifact, "/constraints/*", at, "removed", path, None))
    return found


def core_build(document, intent: Intent, state) -> list:
    """Core's parse of every form HQ built for one state that Core's parser took, against the document."""
    found = []
    files = state.build.files or {}
    for position, form in _forms(intent):
        name = form_file(*position.split("."))
        if name in files:
            artifact = f"core:form:{position}@{state.name}"
            nodes = state.nodes(name, artifact)
            if nodes is not None:  # one Core's parser refused is the bar's (admission@<state>)
                found += core_form(document, form, nodes, artifact)
    return found


def core_local(document, intent: Intent, shapes, prefix) -> list:
    """Core's parse of every form of a local ``.ccz`` (``shapes``: each form of the archive, by its file, as
    ``HeldState.shapes`` holds them): the validations the document authors."""
    found = []
    for position, form in _forms(intent):
        name = form_file(*position.split("."))
        artifact = f"core:{prefix}/form:{position}"
        if name not in shapes:
            found.append(_difference(document, artifact, "/", "/", "removed", name, None))
            continue
        nodes = _nodes(shapes, name, artifact)
        if nodes is not None:  # one Core's parser refused is the bar's (admission@<archive>)
            found += core_form(document, form, nodes, artifact, cases=False)
    return found


def archive_shapes(observed, blobs):
    """Each local archive's form parses, as ``core_local`` reads them: ``{archive: {file: nodes or refusal}}``."""
    return {
        archive: {
            file: shape if isinstance(shape, dict) else blobs.get_json(shape) for file, shape in held["forms"].items()
        }
        for archive, held in observed["archives"].items()
    }


# One document --------------------------------------------------------------------


def search_compiles(document, records, name) -> list:
    """Each CSQL string build(A)'s sessions sent under one configuration that HQ's compiler refuses, where the
    document states a search HQ runs (``proof.observe.sessions.search_compiles``, the ``b_aligned`` record's):
    ``csql@A``, ``/*/raised/<exception class>/<where HQ raised it>`` (the string in ``at``), never by the message,
    which holds the document's values. A string whose compile reads the case index compiled."""
    held = _configuration_records(document, records, name)
    sessions = (held.part("b_aligned") or {}).get("sessions") or {}
    found = []
    for compiled in sessions.get("csql") or []:
        raised = compiled.get("raised")
        if raised is None:
            continue
        cause = f"/raised/{pointer_token(raised['class'])}/{pointer_token(raised['site'])}"
        found.append(
            _difference(
                document.id,
                "csql@A",
                f"/*{cause}",
                f"/{pointer_token(compiled['query'])}{cause}",
                "refused",
                None,
                {"query": compiled["query"], "caseTypes": compiled["caseTypes"], "message": raised["message"]},
            )
        )
    return found


def state_differences(document, intent, state, configuration, manifest_items) -> list:
    found = module_case_types(document, intent, state)
    found += learned_properties(document, intent, state)
    found += data_dictionary(document, intent, state, configuration.privileges)
    if state.build.files is not None:
        found += attachment_paths(document, intent, state)
        found += profile_settings(document, intent, state, configuration, manifest_items)
        found += core_build(document, intent, state)
    return found


def _deduplicated(differences):
    seen, kept = set(), []
    for difference in differences:
        marker = json.dumps(difference.as_json(), sort_keys=True)
        if marker not in seen:
            seen.add(marker)
            kept.append(difference)
    return kept


def _configuration_records(document, records, name):
    held = records.configurations.get(name)
    if held is None:
        raise ObservationMissing(
            f"The records of {document.id} hold no {name} configuration, which it is exported under."
        )
    return held


def intent_differences(document, records, manifest_items) -> list:
    """Every intent difference on one corpus document, from its records (``proof.observe.record.DocumentRecords``):
    its states under each configuration, its archives, a targeted document's values, and every note HQ made in
    the operations the intent observation ran."""
    blobs = records.blobs
    intent = intent_of(document)
    found = []
    for name in sorted(document.exports):
        held = _configuration_records(document, records, name)
        configuration = JudgedConfiguration.of(name, held.a)
        for part, state_name in (("a", "A"), ("b", "B")):
            state = held_state(held.part(part), state_name, blobs)
            if state is not None:
                found += state_differences(document.id, intent, state, configuration, manifest_items)
        found += search_compiles(document, records, name)
    archives = archive_shapes(local_observation(document, records), blobs)
    for prefix in ("local.ccz", "local-again.ccz"):
        if prefix in archives:
            found += core_local(document.id, intent, archives[prefix], prefix)
    if document.edit is not None:
        edited = intent_of(document, edit=True)
        for name in sorted(document.edit.exports):
            held = _configuration_records(document, records, name)
            state = held_state(held.part("b_edit"), "B-edit", blobs)
            if state is not None:
                configuration = JudgedConfiguration.of(name, held.a)
                found += state_differences(document.id, edited, state, configuration, manifest_items)
        if "edit/local.ccz" in archives:
            found += core_local(document.id, edited, archives["edit/local.ccz"], "edit/local.ccz")
    if document.expected is not None:
        found += value_differences(document, records)
    found += observations.soft_assertion_differences(records, "intent")
    return _deduplicated(found)


# Value-level checks, on a targeted document ----------------------------------------


def _form_position(document, form_uuid):
    position = form_position(document.wire_modules, form_uuid)
    if position is None:
        raise CorpusLayoutError(
            f"{document.root / 'expected.json'} names the form {form_uuid}, which the wire layout does not place."
        )
    return position


def _pointer(value, pointer):
    for token in pointer.split("/")[1:]:
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(value, list) and token.isdigit() and int(token) < len(value):
            value = value[int(token)]
        elif isinstance(value, dict) and token in value:
            value = value[token]
        else:
            return _ABSENT
    return value


_ABSENT = {"absent": "Core's result holds nothing at this pointer."}


def _structural(pointer):
    return "/".join("*" if token.isdigit() else token for token in pointer.split("/"))


def _evaluated(document, observed, entry, artifact, ran_in):
    """The observation's outcome of one expectation; where Core's evaluate raised on it, ``CoreRaised`` names the
    expectation, where its request ran (``ran_in``) and what Core said."""
    outcome = (observed.get("evaluations") or {}).get(entry["id"])
    if outcome is None:
        raise ObservationMissing(
            f"The records hold no evaluation of {entry['id']} ({artifact}), which the intent check reads; the"
            " observation (proof/observe/intent.py) runs every expectation where its export is."
        )
    if "failed" in outcome:
        raised = outcome["failed"]
        raise CoreRaised(
            f"Core's evaluate raised {raised['class']} on the expectation {entry['id']} ({artifact}), whose request"
            f" ran in {ran_in}, so it gave no values to compare. Core said: {_said(raised)}. Look at the"
            f" expectation's request in {document.root / 'expected.json'}: the session it opens, the answers and"
            " instances it gives, and the restore it reads, against what the form or case list it runs in needs."
        )
    return outcome


def value_differences(document, records) -> list:
    """Each expectation of a targeted document's ``expected.json``, as Core's evaluate gave it where its export is.

    A form check ran in the form's own bytes (Nova's local export's, or the
    one HQ built for A or B); a case list ran in the installed local archive.
    """
    blobs = records.blobs
    found = []
    for entry in expectations(document):
        name = form_file(*_form_position(document, entry["form"]))
        artifact = f"evaluate:{entry['id']}@{entry['export']}"
        if entry["export"] == "local":
            observed = local_observation(document, records)
            forms = (observed["archives"].get("local.ccz") or {}).get("forms", {})
            if "caseList" in entry["request"]:
                ran_in = "the case list of the installed local.ccz"
            elif name not in forms:
                raise CorpusLayoutError(f"{document.local_ccz} holds no {name}, the form {entry['form']}.")
            else:
                ran_in = f"{name} of local.ccz"
        else:
            configuration = entry.get("configuration", DEFAULT_CONFIGURATION)
            if configuration not in document.exports:
                raise CorpusLayoutError(
                    f"{document.root / 'expected.json'}: {entry['id']} names the configuration {configuration!r},"
                    " which the document is not exported under."
                )
            held = _configuration_records(document, records, configuration)
            record = held.part("a" if entry["export"] == "A" else "b") or {}
            state = record.get("state")
            files = outcome_from_record(state["build"], blobs, entry["export"]).files if state else None
            if files is None:
                # HQ refused the publish or its build failed: the bar reports why (``import@`` or ``<step>@``).
                continue
            if name not in files:
                message = f"HQ's build of {entry['export']} holds no {name}, the form {entry['form']}."
                found.append(
                    _difference(document.id, artifact, "/no-form-file", "/no-form-file", "refused", None, message)
                )
                continue
            observed = (record.get("hooks") or {}).get("intent") or {}
            forms = observed.get("forms") or {}
            ran_in = f"{name} of HQ's build of {entry['export']} under {configuration}"
        if "caseList" not in entry["request"] and "refused" in (forms.get(name) or {}):
            # Core's parser refused the form the request runs in, as Core's evaluate parses it: the bar reports it
            # (``admission@<state>``, ``admission@local.ccz``), as for every structural check.
            continue
        outcome = _evaluated(document, observed, entry, artifact, ran_in)
        if "refused" in outcome:
            if not (observations.local_reports(records).get("local.ccz") or {}).get("admitted"):
                # Core did not admit the local archive the case list runs in: the bar reports its problems
                # (``admission@local.ccz``).
                continue
            found.append(
                _difference(
                    document.id,
                    artifact,
                    "/not_admitted",
                    "/not_admitted",
                    "refused",
                    None,
                    blobs.get_json(outcome["refused"]),
                )
            )
            continue
        result = blobs.get_json(outcome["result"])
        for expectation in entry["expect"]:
            observed_value = _pointer(result, expectation["pointer"])
            if observed_value != expectation["value"]:
                found.append(
                    _difference(
                        document.id,
                        artifact,
                        _structural(expectation["pointer"]),
                        expectation["pointer"],
                        "changed",
                        expectation["value"],
                        observed_value,
                    )
                )
    return found
