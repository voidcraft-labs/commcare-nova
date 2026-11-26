"""What a lookup table's tag does to a form made in CommCare HQ's own form builder, in the same project space.

Contract: HQ's form designer hands Vellum the session (``commcaresession``), the case database (``casedb``, where
the form needs a case), a registry's cases (``registry``, where the menu loads one) and then every table of the
project space, each table under its bare tag (``views/formdesigner.py::get_form_data_schema``,
``fixtures/fixturegenerators.py::item_lists_by_domain`` without ``namespace_ids``, sorted by name). Vellum indexes
those by id, a later source taking an earlier one's place (``datasources.js``: ``_.indexBy(sources, "id")``), and
records each id's source among the instances it knows (``form.js::updateKnownInstances``), the map in which it
also keeps every instance a form declares and from which it declares an instance a form reads
(``form.js::parseInstanceRefs``, ``addInstanceIfNotExists``). The comparison is JavaScript's, of the whole id,
case and all. A table Nova publishes into a project space therefore reaches every form there, read or not.

The plausible failures: a tag equal to an id the builder already holds (the session, a registry's cases), so a
form's references to that source lose their meaning on a save; a tag equal to an instance id HQ's build gives
a form that reads it undeclared (``suite_xml/post_process/instances.py``: ``groups``, ``locations``, ``results``
and the rest), so a save declares the table in its place and the form reads the table; and a tag that shadows a
method Vellum calls on its index (``hasOwnProperty``) or the index's prototype (``__proto__``).

``hq-plain``'s follow-up form, saved by HQ's form builder with its ``#case/members`` default
(``proof/matrix/bases/plain.py``), is published into a fresh project space. For a tag HQ's build reads as its own
instance, the builder first gives the form's remark a default reading that instance, undeclared, as a person
types it; for ``registry`` the menu loads a registry's case and the default reads ``#registry_case/members``.
The builder saves the form twice (the second save is the baseline: a first save may still settle the source),
HQ builds it, the project space gains a table with the tag under test and a second table whose tag sorts after
it (so the builder indexes an id after the tag's own), and the builder opens and saves the form again. The form
opens, saves the baseline's source, keeps its references, validates, and builds with the same instance
declarations, unless ``BREAKS`` names what it does instead.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from proof.editors import vellum
from proof.editors.conftest import write_evidence
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.conftest import nova_shaped_upload
from proof.hq.configuration import Configuration

BASE = Path(__file__).resolve().parents[1] / "hq-apps" / "hq-plain" / "app.json"
CASE_REFERENCE = 'vellum:value="#case/members"'
FORM = "modules-0/forms-1.xml"
REMARK = "/data/remark"


@dataclass(frozen=True)
class Reads:
    """The default the builder gives the remark before the table exists, and the text a save keeps of it."""

    value: str
    kept: str
    registry: bool = False
    flags: frozenset = field(default_factory=frozenset)


# Instance ids HQ's build declares for a form that reads them undeclared (``INSTANCE_KWARGS_BY_ID`` and the
# factories that take an id with no colon), each read as a person writes the read.
BUILD_READS = {
    "groups": "count(instance('groups')/groups/group)",
    "reports": "count(instance('reports')/reports/report)",
    "locations": "count(instance('locations')/locations/location)",
    "results": "count(instance('results')/results/case)",
    "search-input": "count(instance('search-input')/input/field)",
    "selected_cases": "count(instance('selected_cases')/results/value)",
    "case-search-fixture": "count(instance('case-search-fixture')/values/value)",
}
READS = {tag: Reads(value, value) for tag, value in BUILD_READS.items()}
READS["registry"] = Reads(
    "#registry_case/members", 'vellum:value="#registry_case/members"', registry=True, flags=frozenset({"DATA_REGISTRY"})
)

# The other ids the builder or HQ's build keeps for itself, which no form here reads: the factories' prefixes
# (``item-list``, ``schedule``, ``indicators``, ``commtrack``, ``commcare``, ``commcare-reports``,
# ``commcare-reports-filters``), Vellum's ledger instance (``commtrack.js::LEDGER_INSTANCE_ID``) and the id it
# numbers a new instance from (``form.js::addInstanceIfNotExists``: ``data``). ``casedb`` and ``ledgerdb`` are
# refused already, for CommCare's own reason.
UNREAD = (
    "commcaresession",
    "item-list",
    "schedule",
    "indicators",
    "commtrack",
    "commcare",
    "commcare-reports",
    "commcare-reports-filters",
    "ledger",
    "data",
)
# ``Object.prototype``'s own members, which name a property of every plain object Vellum indexes with.
INHERITED = (
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
)
# Each held name's neighbours: the comparison is the whole id, case and all. ``input`` and
# ``search_selected_cases`` are instance ids Nova's own form writer gives way to, which HQ's form builder does not
# hold.
OUTSIDE = (
    "CommCareSession",
    "commcaresession2",
    "HasOwnProperty",
    "hasownproperty",
    "hasOwnProperty2",
    "__proto",
    "Registry",
    "Locations",
    "Groups",
    "Results",
    "input",
    "search_selected_cases",
    "plain_sites",
)
TAGS = (*READS, *UNREAD, *INHERITED, *OUTSIDE)


def _table(state, tag):
    from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow, TypeField

    made = LookupTable.objects.create(
        domain=state.domain,
        tag=tag,
        is_global=True,
        fields=[TypeField(name="code", properties=[], is_indexed=False)],
        item_attributes=[],
    )
    LookupTableRow.objects.create(
        domain=state.domain,
        table=made,
        fields={"code": [Field(value="north", properties={})]},
        item_attributes={},
        sort_key=0,
    )


def _loads_a_registry_case(state, app_id):
    """The menu's search reads a registry and loads the chosen case from it (``util.py::module_loads_registry_case``),
    as HQ's Case Search page saves those settings."""
    from corehq.apps.app_manager.const import REGISTRY_WORKFLOW_LOAD_CASE
    from corehq.apps.app_manager.models import CaseSearchProperty

    app = operations.held_app(state, app_id)
    config = app.modules[0].search_config
    config.properties = [CaseSearchProperty(name="members", label={"en": "Members"})]
    config.data_registry = "proof-registry"
    config.data_registry_workflow = REGISTRY_WORKFLOW_LOAD_CASE
    app.save()


def _without_case_default(source):
    """The follow-up form without its ``#case/members`` default: a menu that loads a registry's case gives the form
    builder no ``#case/`` source (``casedb_schema.py::get_casedb_schema`` lists no case subsets then), so the
    registry's form reads its case through ``#registry_case/`` alone."""
    form = source["modules"][0]["forms"][1]
    name = f"{form['unique_id']}.xml"
    xml = source["_attachments"][name]
    kept = re.sub(r'<setvalue [^>]*ref="/data/members"[^>]*/>', "", xml)
    if kept == xml:
        raise AssertionError("hq-plain's follow-up form holds no #case/members default to leave out.")
    source["_attachments"][name] = kept


def _declarations(app):
    """The instance declarations of the follow-up form in HQ's build, id to src, or the build's refusal."""
    from lxml import etree

    try:
        files = app.create_all_files()
    except Exception as error:  # noqa: BLE001 - the refusal is the observation
        return {"refused": f"{type(error).__name__}: {str(error)[:300]}"}
    root = etree.fromstring(files[FORM] if isinstance(files[FORM], bytes) else files[FORM].encode())
    return {
        element.get("id"): element.get("src")
        for element in root.iter("{http://www.w3.org/2002/xforms}instance")
        if element.get("id")
    }


# HQ's form builder copies a required condition into one more ``vellum:vellum__…required`` attribute on every save
# of ``hq-plain``'s remark, with or without a table: its own drift, which the comparison leaves out.
BUILDER_DRIFT = re.compile(r' vellum:(?:vellum__)+required="[^"]*"')


def _settled(source):
    return None if source is None else BUILDER_DRIFT.sub("", source)


def _remark(source):
    """The remark's default and the form's instance declarations, as the evidence records them."""
    if not source:
        return None
    return re.findall(r'<instance [^>]*>|<setvalue [^>]*ref="/data/remark"[^>]*>', source)


def _outcome(run, app, reads):
    stored = run.stored_source or ""
    return {
        "loaded": run.loaded,
        "load_error": run.load_error,
        "saved": run.saved,
        "save_refusal": run.save_refusal,
        "page_errors": [str(error).split("\n", 1)[0] for error in run.page_errors],
        "form_errors": run.form_errors,
        "case_reference_kept": (reads is not None and reads.registry) or CASE_REFERENCE in stored,
        "read_kept": reads is None or reads.kept in stored,
        "validation": sorted({error.get("type") for error in app.validate_app()}),
    }


def _validation_messages(app):
    return [{key: str(value)[:300] for key, value in error.items() if key != "form"} for error in app.validate_app()]


SURVIVES = {
    "loaded": True,
    "load_error": None,
    "saved": True,
    "save_refusal": None,
    "page_errors": [],
    "form_errors": [],
    "case_reference_kept": True,
    "read_kept": True,
    "validation": [],
    "source_unchanged": True,
    "declarations_unchanged": True,
}
# A save declares the table under the instance id HQ's build would have declared as its own, so the form reads
# the table there (pr3c-ed-2).
TAKES_A_BUILD_INSTANCE = {**SURVIVES, "source_unchanged": False, "declarations_unchanged": False}
# What each tag that breaks the form does instead, as observed (pr3c-editor-1, pr3c-ed-2, pr3c-ed-4).
BREAKS = {
    **{tag: TAKES_A_BUILD_INSTANCE for tag in BUILD_READS},
    # The save rewrites ``#registry_case/members`` onto the table's path (``instance('registry')/registry_list/
    # registry[…]``) under the registry's own declaration, so the form reads nothing there.
    "registry": {**SURVIVES, "source_unchanged": False},
    "commcaresession": {
        **SURVIVES,
        "case_reference_kept": False,
        "validation": ["validation error"],
        "source_unchanged": False,
    },
    "hasOwnProperty": {
        **SURVIVES,
        "loaded": False,
        "load_error": "TypeError: t2.hasOwnProperty is not a function",
        "saved": False,
        "save_refusal": "the form did not load",
        "page_errors": ["TypeError: t2.hasOwnProperty is not a function"],
    },
}


@pytest.mark.parametrize("tag", TAGS)
def test_a_project_space_table_and_hq_made_forms(tag, hq, core_runner, editor_driver):
    reads = READS.get(tag)
    configuration = Configuration(
        flags=reads.flags if reads else frozenset(), privileges={"CLOUDCARE", "LOOKUP_TABLES"}
    )
    with hq_check(configuration) as (state, _):
        source = json.loads(BASE.read_text(encoding="utf-8"))
        if reads is not None and reads.registry:
            _without_case_default(source)
        app_id, _ = operations.publish(state, [nova_shaped_upload(source, "hq-plain")])
        app = operations.held_app(state, app_id)
        app.ensure_module_unique_ids(should_save=True)
        if reads is not None and reads.registry:
            _loads_a_registry_case(state, app_id)
        form_id = operations.held_app(state, app_id).modules[0].forms[1].unique_id
        edit = (
            None
            if reads is None
            else {"path": REMARK, "property": "defaultValue", "value": reads.value, "way": "builder-model"}
        )
        first = vellum.open_and_save(editor_driver, state, app_id, form_id, edit=edit)
        baseline = vellum.open_and_save(editor_driver, state, app_id, form_id)
        held = operations.held_app(state, app_id)
        before = _outcome(baseline, held, reads)
        before_declarations = _declarations(held)
        baseline_messages = _validation_messages(held)
        _table(state, tag)
        # The trailing table: an id after the tag's own in the builder's index (sorted by name), within the 32
        # characters a tag holds.
        _table(state, ("zz_" + tag.strip("_").lower())[:32])
        after = vellum.open_and_save(editor_driver, state, app_id, form_id)
        held = operations.held_app(state, app_id)
        outcome = _outcome(after, held, reads)
        after_declarations = _declarations(held)
        outcome["source_unchanged"] = (
            _settled(after.stored_source) == _settled(baseline.stored_source) if after.saved else True
        )
        outcome["declarations_unchanged"] = after_declarations == before_declarations
        messages = {"baseline": baseline_messages, "after": _validation_messages(held)}

    write_evidence(
        f"project-space-table-{tag}",
        {
            "first_saved": first.saved,
            "baseline": before,
            "after": outcome,
            "declarations_before": before_declarations,
            "declarations_after": after_declarations,
            "validation_messages": messages,
            "remark_baseline": _remark(baseline.stored_source),
            "remark_after": _remark(after.stored_source),
            "source_after": after.stored_source if not outcome["source_unchanged"] else None,
            "source_baseline": baseline.stored_source if not outcome["source_unchanged"] else None,
        },
    )
    assert {**before, "source_unchanged": True, "declarations_unchanged": True} == SURVIVES, before
    assert outcome == BREAKS.get(tag, SURVIVES), outcome
