"""HQ's case lowering of Nova's case exports (``case`` and ``relation-instance`` families).

HQ imports each export (``Application.from_source``) and builds its case
blocks with its own classes: ``XForm._create_casexml`` for the extension
scenarios, ``XForm._add_usercase`` and the worker datum and assertion
builders for the worker scenarios, and ``XForm.add_case_and_meta`` with
``strip_vellum_ns_attributes`` for the capture and operation forms Core then
executes. Each regenerated form is written beside its input as
``<scenario>.hq.xml``; for the ``case`` family, what its HQ check compares is
returned, and for ``relation-instance``, whose forms only Core reads, the
names of the forms written.
"""

from lxml import etree

from proof.native.hq_support import import_source, native_check, regenerate_form, sha256

DOMAIN = "nova-case-evidence"
EXTENSION_SCENARIOS = ["registration", "followup", "repeat", "query", "multiple", "multiple-repeat"]
WORKER_SCENARIOS = ["worker-survey", "worker-followup"]
CAPTURE_SCENARIOS = ["registration", "followup", "repeat", "query", "multiple"]
OPERATION_SCENARIOS = [
    "sequence",
    "conditional",
    "retype",
    "expression-retype",
    "repeat",
    "query",
    "key-query",
    "key",
    "link",
    "scalar",
    "relation",
    "nested",
]
RELATION_INSTANCE_SCENARIOS = ["instance-count", "instance-count-condition", "instance-exists", "instance-missing"]
NAMESPACES = {"x": "http://www.w3.org/2002/xforms", "cx": "http://commcarehq.org/case/transaction/v2"}
NATIVE_FILES = [
    "corehq/apps/app_manager/xform.py",
    "corehq/apps/app_manager/suite_xml/xml_models.py",
    "corehq/apps/app_manager/xpath.py",
    "corehq/apps/app_manager/models/applications.py",
    "corehq/apps/app_manager/models/forms.py",
    "corehq/apps/app_manager/models/form_actions.py",
    "corehq/apps/app_manager/suite_xml/sections/entries.py",
    "corehq/apps/app_manager/suite_xml/post_process/workflow.py",
]


def _extension(exports, scenario):
    from corehq.apps.app_manager.suite_xml.post_process.workflow import (
        WorkflowDatumMeta,
        _find_best_match,
        workflow_meta_from_session_datum,
    )
    from corehq.apps.app_manager.suite_xml.sections.entries import EntriesHelper
    from corehq.apps.app_manager.xform import XForm

    raw = (exports / f"{scenario}.json").read_bytes()
    app = import_source(raw, DOMAIN)
    form = app.get_module(0).get_form(0)
    owner_values = None
    if scenario == "followup":
        preload_form = XForm(form.source, domain=DOMAIN)
        preload_form.add_case_preloads({"/data/episode_note": "owner_id"})
        preload_tree = etree.fromstring(etree.tostring(preload_form.xml))
        owner_values = preload_tree.xpath(
            '//x:model/x:setvalue[@ref="/data/episode_note"]/@value', namespaces=NAMESPACES
        )
    xform = XForm(form.source, domain=DOMAIN)
    xform._create_casexml(form)
    native_xml = etree.tostring(xform.xml)
    (exports / f"{scenario}.hq.xml").write_bytes(native_xml)
    datums = EntriesHelper.get_new_case_id_datums_meta(form)
    matched_id = None
    if scenario == "registration":
        source = []
        for meta in datums:
            datum = workflow_meta_from_session_datum(meta.datum, None)
            datum.case_type = meta.case_type
            source.append(datum)
        target = WorkflowDatumMeta("case_id", "instance('casedb')/casedb/case[@case_type='episode']", None, False)
        matched = _find_best_match(target, source)
        matched_id = None if matched is None else matched.source_id
    return {
        "scenario": scenario,
        "inputSha256": sha256(raw),
        "native": native_xml,
        "local": (exports / f"{scenario}.xml").read_bytes(),
        "ownerPreloadValues": owner_values,
        "datumIds": [meta.datum.id for meta in datums],
        "datumFunctions": [str(meta.datum.function) for meta in datums],
        "linkSourceId": matched_id,
    }


def _worker(exports, scenario):
    from corehq.apps.app_manager.suite_xml.sections.entries import EntriesHelper
    from corehq.apps.app_manager.suite_xml.xml_models import Entry
    from corehq.apps.app_manager.xform import XForm

    raw = (exports / f"{scenario}.json").read_bytes()
    app = import_source(raw, DOMAIN)
    form = app.get_module(0).get_form(0)
    xform = XForm(form.source, domain=DOMAIN)
    xform._create_casexml(form)
    xform._add_usercase(form)
    native_xml = etree.tostring(xform.xml)
    datums = EntriesHelper.get_extra_case_id_datums(form)
    (exports / f"{scenario}.hq.xml").write_bytes(native_xml)
    expected_entry = Entry()
    EntriesHelper.add_usercase_id_assertion(expected_entry)
    return {
        "scenario": scenario,
        "inputSha256": sha256(raw),
        "native": native_xml,
        "local": (exports / f"{scenario}.xml").read_bytes(),
        "suite": (exports / f"{scenario}.suite.xml").read_bytes(),
        "xmlns": form.xmlns,
        "datums": [
            {"id": meta.datum.id, "function": str(meta.datum.function), "requiresSelection": meta.requires_selection}
            for meta in datums
        ],
        "assertionTest": str(expected_entry.assertions[0].test),
        "assertionLocaleId": expected_entry.assertions[0].text[0].locale_id,
    }


def _regenerated(exports, name, module_index=0):
    raw = (exports / f"{name}.json").read_bytes()
    app = import_source(raw, DOMAIN)
    form = app.get_module(module_index).get_form(0)
    native_xml = regenerate_form(form, DOMAIN)
    (exports / f"{name}.hq.xml").write_bytes(native_xml)
    local = (exports / f"{name}.xml").read_bytes()
    return {"scenario": name, "inputSha256": sha256(raw), "native": native_xml, "local": local}


def cases(session):
    exports = session.family("case")
    with native_check(DOMAIN):
        extensions = [_extension(exports, scenario) for scenario in EXTENSION_SCENARIOS]
        captures = [_regenerated(exports, f"capture-{scenario}") for scenario in CAPTURE_SCENARIOS]
        operations = [
            _regenerated(exports, f"operation-{scenario}", 1 if scenario == "nested" else 0)
            for scenario in OPERATION_SCENARIOS
        ]
    # A worker-record write needs the usercase, which HQ grants with the
    # USERCASE privilege (app_manager/util.py::domain_has_usercase_access).
    with native_check(DOMAIN, privileges={"USERCASE"}):
        workers = [_worker(exports, scenario) for scenario in WORKER_SCENARIOS]
    return {"extensions": extensions, "workers": workers, "captures": captures, "operations": operations}


def relation_instances(session):
    """The four relation-instance forms, regenerated for ``RelationInstanceRuntimeTest``; their names."""
    exports = session.family("relation-instance")
    with native_check(DOMAIN):
        operations = [_regenerated(exports, f"operation-{scenario}") for scenario in RELATION_INSTANCE_SCENARIOS]
    return [record["scenario"] for record in operations]
