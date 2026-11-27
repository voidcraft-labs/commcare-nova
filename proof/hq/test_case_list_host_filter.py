"""The Case List editor and Core's worker list distinguish a host from the listed case."""

import json

from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.matrix import ops
from proof.matrix.authoring import Authoring
from proof.matrix.registry import BASES, HQ_APPS, load_variants
from proof.observe import casedata
from proof.observe.build import arrange


def host_filter():
    (variant,) = (v for v in load_variants() if v.id == "hq-case-lists/filter-reading-the-host")
    assert variant.change["pointer"] == "/modules/0/case_details/short/filter"
    return variant.change["value"]


def restore(domain, first_host, second_host):
    def row(key, case_type, village, indices=()):
        stamp = "2025-12-01T08:00:00.000Z"
        return casedata.CaseRecord(
            key, case_type, key, casedata.USER_ID, stamp, stamp, None, (("village", village),), indices,
        )

    return casedata.restore(casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        row("host-north", "household", "north"),
        row("host-south", "household", "south"),
        row("first", "patient", "south", (("host", "household", first_host, "extension"),)),
        row("second", "patient", "south", (("host", "household", second_host, "child"),)),
        row("wrong-index", "patient", "north", (("parent", "household", "host-north", "child"),)),
        row("missing-index", "patient", "north"),
        row("missing-host", "patient", "north", (("host", "household", "not-restored", "extension"),)),
    )), domain)


def save_and_build(authoring, app_id, filter_text, path):
    # The Case List editor serializes each control, including its filter. The
    # view leaves the other controls alone when they are outside this request.
    from corehq.apps.app_manager.tests.util import patch_get_xform_resource_overrides

    app = operations.held_app(authoring.state, app_id)
    module = app.get_module(0)
    body, content_type = ops.form_body([("type", json.dumps("case")), ("filter", json.dumps(filter_text))])
    ops.post(authoring, "edit_module_detail_screens", [app_id, module.unique_id], body, content_type,
             "the Patients list filter")
    held = operations.held_app(authoring.state, app_id)
    assert held.get_module(0).case_details.short.filter == filter_text
    with patch_get_xform_resource_overrides():
        suite = etree.fromstring(held.create_suite())
        files = held.create_all_files()
    nodesets = suite.xpath(".//datum[@detail-select='m0_case_short']/@nodeset")
    assert nodesets, etree.tostring(suite)
    return arrange(files, path), nodesets


def selected_patients(core_runner, archive, restored):
    admitted = core_runner.admit(archive)
    assert admitted["admitted"], admitted["problems"]
    try:
        result = core_runner.session(admitted["app"], restore=restored)
    finally:
        core_runner.release(admitted["app"])
    lists = [
        step for run in result["runs"] for step in run["trace"]
        if step.get("screen") == "case-list" and step.get("detail") == "m0_case_short"
    ]
    assert lists, result
    choices = [{row["caseId"] for row in step["rows"]} for step in lists]
    assert all(choice == choices[0] for choice in choices), lists
    return choices[0]


def test_saved_host_filter_follows_only_the_listed_cases_host(hq, core_runner, tmp_path):
    (base,) = (base for base in BASES if base.id == "hq-case-lists")
    retained = json.loads((HQ_APPS / base.id / "app.json").read_text(encoding="utf-8"))
    with hq_check(base.configuration) as (state, _):
        authoring = Authoring(state=state, documents={}, base=base.id, operation=state.operation)
        app_id = operations.save_authored_app(state, retained, ())
        host, host_nodesets = save_and_build(authoring, app_id, host_filter(), tmp_path / "host")
        own, own_nodesets = save_and_build(authoring, app_id, "village = 'north'", tmp_path / "own")
        original = restore(state.domain, "host-north", "host-south")
        swapped = restore(state.domain, "host-south", "host-north")

    for nodeset in host_nodesets:
        assert "[instance('casedb')/casedb/case[@case_id=current()/index/host]/village = 'north']" in nodeset
    for nodeset in own_nodesets:
        assert "[village = 'north']" in nodeset

    assert {
        "host": selected_patients(core_runner, host, original),
        "swapped": selected_patients(core_runner, host, swapped),
        "own": selected_patients(core_runner, own, original),
    } == {
        "host": {"first"},
        "swapped": {"second"},
        "own": {"wrong-index", "missing-index", "missing-host"},
    }
