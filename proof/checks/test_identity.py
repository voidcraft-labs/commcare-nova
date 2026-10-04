"""Proof 1 sees each identity an update changes, and nothing an update keeps.

Contract: ``identity.app_identity`` reads every identity of the research's
table from what HQ holds and builds, and ``compare_identities`` reports a
difference exactly where one changed. After an edit, ``proof1.edit_identity``
compares exactly the identities outside the batch's footprint: a footprint
form's own identities are not compared, and neither is a case type a
footprint module declares or a footprint form writes. Where HQ holds no
state to compare, proof 1 names that only where the bar does not already
say why. The plausible failures: an identity read from somewhere an update
never reaches (so a change goes unseen), one read from something HQ
re-mints on every read (``app_source``'s form ids), which would report
changes no publish made, an edit's footprint that hides changes outside
it, or reports the changes it makes, and a refused publish reported again
as a missing later state, one cause in two classes.

The app is HQ's own suite-test app (``proof.checks.suite_app``). Its update
keeps every id HQ holds (the update Nova's publish should send) and changes
two identities: one select value of its first form, and one case property
name that form writes to the module's case type (which the second form
writes too).
"""

from __future__ import annotations

import pytest

from proof.checks import bar, proof1, suite_app
from proof.checks.identity import compare_identities
from proof.checks.observations import AppState, EditPublish, Refusal, Republish


@pytest.fixture(scope="module")
def change(hq, core_runner):
    return suite_app.identity_change(core_runner)


def test_proof1_reports_the_identities_an_update_changes_and_no_other(change):
    (built_a, identities_a), (built_b, identities_b) = change
    assert built_a.complete and built_b.complete
    assert compare_identities(identities_a, identities_a, document="suite-app") == []
    found = compare_identities(identities_a, identities_b, document="suite-app")
    assert {(d.artifact, d.path, d.at, d.kind) for d in found} == suite_app.CHANGED


# The suite app's one module and two forms, placed on the wire as a corpus document's layout places them.
WIRE = {
    "modules": [{"uuid": "module", "forms": ["first-form", "second-form"]}],
    "languages": [{"tag": "en", "code": "en"}],
}


def test_an_edit_is_held_to_identity_outside_its_footprint_only(change):
    (built_a, identities_a), (built_b, identities_b) = change
    observed = EditPublish("suite-app", "minimum")
    observed.a = AppState("A", "suite-app", {}, identities_a, built_a)
    observed.b = AppState("B-edit", "suite-app", {}, identities_b, built_b)

    def found(*footprint):
        differences = proof1.edit_identity("suite-app", observed, WIRE, WIRE, frozenset(footprint), {}, {})
        return {(d.artifact, d.path) for d in differences}

    first_form = {("form:0.0", "/questions/*/options/*"), ("form:0.0", "/case_updates/*/*")}
    case_type = {("case_types", "/*/properties/*")}
    # Outside an empty footprint, every change is seen.
    assert found() == first_form | case_type
    # The edited form's own identities and the case type it writes are the edit's.
    assert found("first-form") == set()
    # Another form writing the same case type reaches the case type, and the edited form's identities stay.
    assert found("second-form") == first_form
    # The module declaring the case type reaches it too; its forms outside the footprint are still compared.
    assert found("module") == first_form


def test_a_state_missing_because_hq_refused_a_publish_is_reported_by_the_bar_alone():
    """B and B-edit are published over A only where HQ accepted A (``proof.observe.unit.observe_configuration``),
    so where HQ refused A the bar says why (``import@A``) and proof 1 adds nothing for A or for the states built on
    it; a state missing with no refusal is one refused comparison naming the first state HQ holds none of."""
    refused = [Refusal("A", 400, {"error": "The app could not be imported."})]
    assert [(d.artifact, d.path) for d in bar.republish_bar("d", Republish("d", "minimum", refusals=refused))] == [
        ("import@A", "/status/400")
    ]
    assert proof1.republish_identity("d", Republish("d", "minimum", refusals=refused)) == []
    assert proof1.edit_identity("d", EditPublish("d", "minimum", refusals=refused), None, None, (), {}, {}) == []
    assert [d.path for d in proof1.republish_identity("d", Republish("d", "minimum"))] == ["/no-A"]
    held = Republish("d", "minimum", a=AppState("A", "app", {}, {}, None))
    assert [d.path for d in proof1.republish_identity("d", held)] == ["/no-B"]
    held.refusals = [Refusal("B", 400, {"error": "The update could not be imported."})]
    assert proof1.republish_identity("d", held) == []
