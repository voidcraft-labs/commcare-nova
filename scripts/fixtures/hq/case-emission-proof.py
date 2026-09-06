"""Read actual Nova exports through native HQ models and case-form compilation.

Only external configuration boundaries are replaced. No DB, remote HQ, Android
build, or form submission runs. Every socket connection is refused.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from unittest.mock import patch

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hq-root", required=True, type=Path)
parser.add_argument("--exports", required=True, type=Path)
parser.add_argument("--python-path", type=Path, help="Optional dependency overlay for the HQ environment")
parser.add_argument("--corpus", choices=["cases", "relation-instances"], default="cases")
args = parser.parse_args()
full_corpus = args.corpus == "cases"
hq_root = args.hq_root.resolve()
sys.path.insert(0, str(hq_root))
if args.python_path:
    sys.path.append(str(args.python_path.resolve()))

def deny_network(*_args, **_kwargs):
    raise RuntimeError("Network disabled for native HQ evidence")

socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
os.environ["CCHQ_TESTING"] = "1"
os.environ["DJANGO_SETTINGS_MODULE"] = "testsettings"
from manage import init_hq_python_path
init_hq_python_path()
import django
django.setup()
from django.conf import settings
from django.test import override_settings
# HQ constructs Redis-backed limiter objects at import without connecting. Swap
# caches only after setup; then Form.source uses in-process storage exclusively.
override_settings(CACHES={name: {
    "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    "LOCATION": f"nova-case-evidence-{name}",
} for name in settings.CACHES}).enable()
from corehq.apps.app_manager.models import Application
from corehq.apps.app_manager.xform import XForm
from corehq.apps.app_manager.suite_xml.sections.entries import EntriesHelper
from corehq.apps.app_manager.suite_xml.post_process.workflow import (
    WorkflowDatumMeta, _find_best_match, workflow_meta_from_session_datum,
)
from corehq.apps.app_manager.suite_xml.xml_models import Entry
from corehq.apps.builds.models import BuildSpec
from lxml import etree

namespaces = {"x": "http://www.w3.org/2002/xforms", "cx": "http://commcarehq.org/case/transaction/v2"}
results = []
for scenario in (["registration", "followup", "repeat", "query", "multiple", "multiple-repeat"] if full_corpus else []):
    raw = (args.exports / f"{scenario}.json").read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-case-evidence")
    form = app.get_module(0).get_form(0)
    owner_preload = None
    if scenario == "followup":
        preload_form = XForm(form.source, domain="nova-case-evidence")
        preload_form.add_case_preloads({"/data/episode_note": "owner_id"})
        preload_tree = etree.fromstring(etree.tostring(preload_form.xml))
        owner_values = preload_tree.xpath('//x:model/x:setvalue[@ref="/data/episode_note"]/@value', namespaces=namespaces)
        assert owner_values == ["instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/@owner_id"]
        owner_preload = owner_values[0]
    with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled", return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False):
        xform = XForm(form.source, domain="nova-case-evidence")
        xform._create_casexml(form)
        native_xml = etree.tostring(xform.xml)
    # Reparse the serialized artifact: HQ builds some tags with namespace
    # prefixes that lxml's in-memory XPath does not resolve before serialization.
    tree = etree.fromstring(native_xml)
    (args.exports / f"{scenario}.hq.xml").write_bytes(native_xml)
    local = etree.fromstring((args.exports / f"{scenario}.xml").read_bytes())
    indexes = tree.xpath('//cx:index/*[@relationship="extension"]', namespaces=namespaces)
    local_indexes = local.xpath('//cx:index/*[@relationship="extension"]', namespaces=namespaces)
    assert len(indexes) == len(local_indexes) == 2, scenario
    assert [dict(node.attrib) for node in indexes] == [dict(node.attrib) for node in local_indexes], scenario
    disabled = tree.xpath('//x:model/x:bind[@relevant="false()"]/@nodeset', namespaces=namespaces)
    expected_prefix = "/data/records/item" if scenario == "query" else "/data/records" if scenario == "repeat" else "/data"
    assert disabled == ([] if scenario in ("multiple", "multiple-repeat") else [f"{expected_prefix}/subcase_0/case", f"{expected_prefix}/subcase_2/case"]), (scenario, disabled)
    datums = EntriesHelper.get_new_case_id_datums_meta(form)
    if scenario == "multiple-repeat":
        expected_ids = []
    elif scenario in ("repeat", "query"):
        expected_ids = ["case_id_new_patient_0"]
    else:
        offset = int(scenario == "registration")
        expected_ids = (["case_id_new_patient_0"] if offset else []) + [f"case_id_new_{name}_{i + offset}" for i, name in enumerate(["episode", "visit", "consent"])]
    assert [m.datum.id for m in datums] == expected_ids, scenario
    assert all(m.datum.function == "uuid()" for m in datums), scenario
    matched_id = None
    if scenario == "registration":
        source = []
        for meta in datums:
            datum = workflow_meta_from_session_datum(meta.datum, None)
            datum.case_type = meta.case_type
            source.append(datum)
        target = WorkflowDatumMeta("case_id", "instance('casedb')/casedb/case[@case_type='episode']", None, False)
        matched = _find_best_match(target, source)
        assert matched is not None
        matched_id = matched.source_id
        assert matched_id == "case_id_new_episode_1"
    results.append({"scenario": scenario, "inputSha256": hashlib.sha256(raw).hexdigest(), "extensionIndexes": [dict(node.attrib) for node in indexes], "disabledNativeTransactions": disabled, "nativeCreateDatums": expected_ids, "nativeLinkSourceId": matched_id, "nativeOwnerPreload": owner_preload})
# The worker scenarios use native action activation, the XForm transaction
# builder, and the suite datum/assertion builders on actual Nova exports.
worker_results = []
for scenario in (["worker-survey", "worker-followup"] if full_corpus else []):
    raw = (args.exports / f"{scenario}.json").read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-case-evidence")
    form = app.get_module(0).get_form(0)
    with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=True), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False):
        xform = XForm(form.source, domain="nova-case-evidence")
        xform._create_casexml(form)
        xform._add_usercase(form)
        native_xml = etree.tostring(xform.xml)
        datums = EntriesHelper.get_extra_case_id_datums(form)
    (args.exports / f"{scenario}.hq.xml").write_bytes(native_xml)
    native = etree.fromstring(native_xml)
    local = etree.fromstring((args.exports / f"{scenario}.xml").read_bytes())
    def worker_binds(tree):
        return sorted([dict(bind.attrib) for bind in tree.xpath('//x:model/x:bind[starts-with(@nodeset, "/data/commcare_usercase/")]', namespaces=namespaces)], key=lambda b: b["nodeset"])
    assert worker_binds(native) == worker_binds(local), scenario
    assert len(worker_binds(native)) == 4, scenario
    # Answer nodes inherit the primary instance's form-specific namespace.
    blocks = native.xpath('//x:model/x:instance[not(@src)]/*/*[local-name()="commcare_usercase"]/cx:case', namespaces=namespaces)
    assert len(blocks) == 1, scenario
    assert [etree.QName(child).localname for child in blocks[0]] == ["update"], scenario
    assert [etree.QName(child).localname for child in blocks[0][0]] == ["visits_done"], scenario
    assert len(datums) == 1 and datums[0].datum.id == "usercase_id" and datums[0].requires_selection is False, scenario
    suite = etree.fromstring((args.exports / f"{scenario}.suite.xml").read_bytes())
    entries = suite.xpath("entry[form=$xmlns]", xmlns=form.xmlns)
    assert len(entries) == 1, scenario
    entry = entries[0]
    assert entry.xpath('session/datum[@id="usercase_id"]/@function') == [str(datums[0].datum.function)], scenario
    expected_entry = Entry()
    EntriesHelper.add_usercase_id_assertion(expected_entry)
    assert entry.xpath('assertions/assert/@test') == [str(expected_entry.assertions[0].test)], scenario
    assert entry.xpath('assertions/assert/text/locale/@id') == [expected_entry.assertions[0].text[0].locale_id], scenario
    worker_results.append({"scenario": scenario, "inputSha256": hashlib.sha256(raw).hexdigest(), "nativeWorkerBinds": worker_binds(native), "nativeWorkerDatum": str(datums[0].datum.function), "nativeWorkerAssertion": str(expected_entry.assertions[0].test)})
# These forms are fully regenerated by native HQ's case/meta lowering and
# stripped of editor attributes, then also executed by the Core proof.
capture_results = []
for scenario in (["registration", "followup", "repeat", "query", "multiple"] if full_corpus else []):
    name = f"capture-{scenario}"
    raw = (args.exports / f"{name}.json").read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-case-evidence")
    form = app.get_module(0).get_form(0)
    with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled", return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False):
        xform = XForm(form.source, domain="nova-case-evidence")
        xform.add_case_and_meta(form)
        xform.strip_vellum_ns_attributes()
        native_xml = etree.tostring(xform.xml)
    (args.exports / f"{name}.hq.xml").write_bytes(native_xml)
    native = etree.fromstring(native_xml)
    local = etree.fromstring((args.exports / f"{name}.xml").read_bytes())
    for tree in [native, local]:
        parent = tree.xpath('//x:model/x:instance[not(@src)]/*/cx:case', namespaces=namespaces)
        assert len(parent) == (0 if scenario == "multiple" else 1), name
        if scenario in ("repeat", "query"):
            assert list(parent[0]) == [], name
        assert len(tree.xpath('//cx:attachment/cx:photo', namespaces=namespaces)) == 1, name
        assert len(tree.xpath('//cx:update/cx:scan_url', namespaces=namespaces)) == 1, name
        assert tree.xpath('//x:model/x:setvalue[contains(@ref,"/details/")]', namespaces=namespaces) == [], name
        assert tree.xpath('//@*[namespace-uri()="http://commcarehq.org/xforms/vellum"]') == [], name
    capture_results.append({"scenario": scenario, "inputSha256": hashlib.sha256(raw).hexdigest(), "nativeFormSha256": hashlib.sha256(native_xml).hexdigest(), "localFormSha256": hashlib.sha256((args.exports / f"{name}.xml").read_bytes()).hexdigest()})
operation_results = []
operation_scenarios = (["sequence", "conditional", "retype", "expression-retype", "repeat", "query", "key-query", "key", "link", "scalar", "relation", "nested"] if full_corpus else ["instance-count", "instance-count-condition", "instance-exists", "instance-missing"])
if not full_corpus:
    assert {source.stem for source in args.exports.glob("*.json")} == {f"operation-{scenario}" for scenario in operation_scenarios}
for scenario in operation_scenarios:
    name = f"operation-{scenario}"
    raw = (args.exports / f"{name}.json").read_bytes()
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads(raw), "nova-case-evidence")
    form = app.get_module(1 if scenario == "nested" else 0).get_form(0)
    with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled", return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False):
        xform = XForm(form.source, domain="nova-case-evidence")
        xform.add_case_and_meta(form)
        xform.strip_vellum_ns_attributes()
        native_xml = etree.tostring(xform.xml)
    (args.exports / f"{name}.hq.xml").write_bytes(native_xml)
    for xml in [native_xml, (args.exports / f"{name}.xml").read_bytes()]:
        tree = etree.fromstring(xml)
        assert len(tree.xpath('//x:model/x:instance[not(@src)]//*[local-name()="__nova_operations"]', namespaces=namespaces)) == 1, name
        assert tree.xpath('//@*[namespace-uri()="http://commcarehq.org/xforms/vellum"]') == [], name
    operation_results.append({"scenario": scenario, "inputSha256": hashlib.sha256(raw).hexdigest(), "nativeFormSha256": hashlib.sha256(native_xml).hexdigest(), "localFormSha256": hashlib.sha256((args.exports / f"{name}.xml").read_bytes()).hexdigest()})
native_files = [
    "corehq/apps/app_manager/xform.py",
    "corehq/apps/app_manager/suite_xml/xml_models.py",
    "corehq/apps/app_manager/xpath.py",
    "corehq/apps/app_manager/models/applications.py",
    "corehq/apps/app_manager/models/forms.py",
    "corehq/apps/app_manager/models/form_actions.py",
    "corehq/apps/app_manager/suite_xml/sections/entries.py",
    "corehq/apps/app_manager/suite_xml/post_process/workflow.py",
]
print(json.dumps({
    "hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(),
    "nativeSourceSha256": {name: hashlib.sha256((hq_root / name).read_bytes()).hexdigest() for name in native_files},
    "evidence": results,
    "workerEvidence": worker_results,
    "captureEvidence": capture_results,
    "operationEvidence": operation_results,
}, indent=2))
