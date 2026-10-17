"""Proof 2, build equivalence: HQ builds the same app after Nova's next publish of an unchanged document.

Contract (plan work item 11, proof 2): ``build(A)`` against ``build(B)`` for a
publish with no edit, after B's module and form ids and ``xmlns`` are mapped
to A's by position (identity is proof 1's): both ``validate_app()`` results
and every file ``create_all_files()`` and each build profile's build write,
compared after the registered spelling rules, with a form's version and
each resource version differing only where that form's or resource's
content differs (HQ's own ``set_form_versions`` decides, with ``build(A)``
as the previous build). The plausible failures: a setting HQ holds that the
next publish drops (defect 4), and a file the comparison never looks at,
which ``compare.build_files`` refuses rather than skips. A form's content is
its bytes as HQ built them, its data node's ``version`` value aside, since
HQ hashes the rendered file: two builds of one form in two layouts may
differ in its version, and two of the same bytes may not.

On a document whose ``hq-side.json`` saves add-ons, what HQ's app, menu and
form pages offer of each saved add-on is held alike at A and at B
(``add_ons@B``): the plausible failure is a publish that replaces the map
whole, so a page stops offering what a person turned on. The judge is held to
a planted page that stops offering one add-on, beside the offers it accepts.
"""

from __future__ import annotations

import pytest

from proof.checks import cases, observations, proof2
from proof.checks.compare.build_files import compare_parsed_builds, parse_build_files
from proof.checks.compare.versions import apply_version_clause

FORM = "modules-0/forms-0.xml"


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("proof2"))
def test_hq_builds_the_same_app_after_the_next_publish(document, hq, core_runner, editor_driver):
    found = proof2.document_build_equivalence(
        document, observations.records_for(document, core_runner, editor_driver=editor_driver)
    )
    cases.hold("proof2", document, found, cases.load_register(), configurations=sorted(document.exports))


def test_a_saved_add_on_a_page_offers_at_a_and_not_at_b_is_reported_at_that_page():
    offered = {
        "app": {"menu_mode": True, "display_conditions": False, "subcases": False},
        "modules": {"0": {"menu_mode": True, "display_conditions": False}},
        "forms": {"0.0": {"menu_mode": True, "display_conditions": False}},
    }
    saved = {"menu_mode": True, "display_conditions": False}
    assert proof2.offered_add_ons("doc", saved, offered, offered) == []
    # A slug nobody saved is not this check's, whatever the pages offer of it.
    other = {**offered, "app": {**offered["app"], "subcases": True}}
    assert proof2.offered_add_ons("doc", saved, offered, other) == []
    lost = {**offered, "modules": {"0": {"menu_mode": False, "display_conditions": False}}}
    found = proof2.offered_add_ons("doc", saved, offered, lost)
    assert [(d.artifact, d.path, d.at, d.kind, d.before, d.after) for d in found] == [
        ("add_ons@B", "/modules/*/menu_mode", "/modules/0/menu_mode", "changed", True, False)
    ]


def _build(version, form):
    """A build's suite and its one form, the form's version ``version`` on its data node and its resource."""
    suite = (
        f'<suite version="9"><xform><resource id="f0" version="{version}">'
        f'<location authority="local">./{FORM}</location></resource></xform></suite>'
    )
    return {"suite.xml": suite.encode(), FORM: form.format(version=version).encode()}


def _version_differences(before, after):
    parsed_a, parsed_b = apply_version_clause(
        parse_build_files(before, rules=()),
        parse_build_files(after, rules=()),
        app_version_before=9,
        app_version_after=9,
    )
    found = compare_parsed_builds(parsed_a, parsed_b, check="proof2", document="d")
    return sorted((d.artifact, d.path) for d in found)


def test_a_forms_version_may_move_where_its_bytes_differ_and_not_where_they_are_the_same():
    form = (
        '<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"><h:head><model>'
        '<instance><data xmlns="http://example.com/f" name="Visit" version="{version}"><q/></data></instance>'
        "</model></h:head><h:body/></h:html>"
    )
    # The same tree in another layout, as HQ's form builder writes a form it saved.
    relaid = form.replace("<q/>", "<q></q>").replace(
        'name="Visit" version="{version}"', 'version="{version}" name="Visit"'
    )
    assert _version_differences(_build(3, form), _build(7, relaid)) == []
    assert _version_differences(_build(3, form), _build(7, form)) == [
        ("form:0.0", "/html/head[*]/model[*]/instance[*]/data[*]/@version"),
        ("suite.xml", "/suite/xform[*]/resource[@id=*]/@version"),
    ]
    # Only the data node's own version is set aside: another element's version is content, compared as it is.
    other = form.replace("<q/>", '<q version="{version}"/>')
    assert _version_differences(_build(3, other), _build(7, other)) == [
        ("form:0.0", "/html/head[*]/model[*]/instance[*]/data[*]/*/@version")
    ]
