"""The bar sees each way HQ's build or Core's admission can fail, and nothing on an app that builds.

Contract: ``proof.observe.build.build_state`` records every step of HQ's
build that fails while the steps after it still run, ``admit_build`` has
Core install HQ's build as HQ's archive download arranges it, and ``bar.build_differences``
reports each failure at its path. The harness's own failures are never HQ's:
a failure of the Core runner answering HQ's validation ends the check, and
every form HQ's validation reaches must have been judged by the runner,
unless HQ's own validation of that form stopped before asking. The
plausible failures: a build step whose exception ends the build so the next
step's failure goes unseen, a ``validate_app`` error reported without the
form it names, an archive Core refuses that the bar reports as admitted, a
runner deadline reported as HQ refusing the app, and a form no one judged
passed over because another form had an error.

The app is HQ's own suite-test app: as HQ's tests build it (the positive
control), with one question bound to a node its form lacks (which HQ's
validation reports and Core refuses), with a build profile naming a
language no form carries (``create_all_files(profile)`` raises, as for
defect 1's renamed language codes), with one form holding no question
(a blank form, which HQ stops validating before asking Formplayer), and with
a form filter HQ cannot build (defect 2's, an error HQ reports after
asking).
"""

from __future__ import annotations

import pytest
from lxml import etree

from proof.checks import bar
from proof.core.client import CoreDeadlineError
from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import hq_test_app, nova_shaped_upload
from proof.hq.seams import build_seams
from proof.observe import build as hqbuild
from proof.observe.identity import data_namespace

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
XFORMS = "http://www.w3.org/2002/xforms"


def _with_unbound_question(app_json):
    form = app_json["modules"][0]["forms"][1]
    name = f"{form['unique_id']}.xml"
    tree = etree.fromstring(app_json["_attachments"][name].encode())
    body = next(el for el in tree.iter() if etree.QName(el).localname == "body")
    question = etree.SubElement(body, f"{{{XFORMS}}}input", ref="/data/not_in_the_instance")
    etree.SubElement(question, f"{{{XFORMS}}}label").text = "Unbound"
    app_json["_attachments"][name] = etree.tostring(tree, encoding="unicode")
    return app_json


class _Unjudged:
    """The seam's record of form validations, without one form's: as if the runner never saw it."""

    def __init__(self, record, xmlns):
        self._record, self._xmlns = record, xmlns

    @property
    def form_validations(self):
        return [v for v in self._record.form_validations if data_namespace(v.xml) != self._xmlns]


def _bar(core_runner, app_json, *, profile_langs=None, validate=None, unjudged=None):
    with hq_check(CONFIGURATION, validate=validate or core_runner.validate_form) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(app_json, "Suite app")])
        app = operations.held_app(state, app_id)
        if profile_langs is not None:
            from corehq.apps.app_manager.models import BuildProfile

            app.build_profiles = {"proof-profile": BuildProfile(name="Proof profile", langs=profile_langs)}
        seen = record if unjudged is None else _Unjudged(record, list(app.get_forms())[unjudged].xmlns)
        with build_seams(previous=None):
            outcome, _ = hqbuild.build_state(app, seen, "A")
            hqbuild.admit_build(core_runner, app, outcome)
    return outcome, bar.build_differences("suite-app", outcome)


def _form_filter(app_json, xpath):
    app_json["modules"][0]["forms"][0]["form_filter"] = xpath
    return app_json


def _without_questions(app_json):
    """The app with its second form holding no question (no answer, bind or control): a blank form to HQ."""
    form = app_json["modules"][0]["forms"][1]
    name = f"{form['unique_id']}.xml"
    tree = etree.fromstring(app_json["_attachments"][name].encode())
    instance = next(el for el in tree.iter() if etree.QName(el).localname == "instance")
    emptied = [instance[0], next(el for el in tree.iter() if etree.QName(el).localname == "body")]
    for element in emptied:
        for child in list(element):
            element.remove(child)
    for bind in [el for el in tree.iter() if etree.QName(el).localname == "bind"]:
        bind.getparent().remove(bind)
    app_json["_attachments"][name] = etree.tostring(tree, encoding="unicode")
    return app_json


def test_an_app_hq_builds_and_core_admits_meets_the_bar(hq, core_runner):
    outcome, found = _bar(core_runner, hq_test_app())
    assert outcome.complete and outcome.admission["admitted"]
    assert found == []


def test_a_form_hq_cannot_validate_is_reported_with_its_form_and_core_refuses_the_build(hq, core_runner):
    outcome, found = _bar(core_runner, _with_unbound_question(hq_test_app()))
    validation = [d for d in found if d.artifact == "validate_app@A"]
    assert validation and {d.at.rpartition("/")[0] for d in validation} == {"/modules/0/forms/1"}
    assert all(d.path.startswith("/modules/*/forms/*/") and d.kind == "error" for d in validation)
    refused = [d for d in found if d.artifact == "admission@A"]
    assert refused and all(d.kind == "refused" and d.path.startswith("/problems/*/") for d in refused)
    assert outcome.admission["admitted"] is False


def test_a_failing_build_profile_is_reported_and_the_default_build_still_runs(hq, core_runner):
    outcome, found = _bar(core_runner, hq_test_app(), profile_langs=["zho"])
    assert outcome.files is not None and outcome.admission["admitted"]  # the default build ran
    assert [(d.artifact, d.path) for d in found] == [
        ("create_all_files:proof-profile@A", "/raised/XFormException"),
    ]
    assert "does not contain any translations" in found[0].after["message"]


def test_a_core_runner_failure_during_hqs_validation_ends_the_check(hq, core_runner):
    def deadline(xml):
        raise CoreDeadlineError("The runner outlived its deadline answering a form validation.")

    with pytest.raises(CoreDeadlineError):
        _bar(core_runner, hq_test_app(), validate=deadline)


def test_every_form_hq_validates_must_reach_the_runner_whatever_another_form_reports(hq, core_runner):
    # Defect 2's form filter: HQ reports it after asking Formplayer about the form, so it excuses nothing.
    outcome, found = _bar(core_runner, _form_filter(hq_test_app(), "#case/@status = 'open'"))
    assert [(d.path, d.at) for d in found if d.artifact == "validate_app@A"] == [
        ("/modules/*/forms/*/form filter has xpath error", "/modules/0/forms/0/form filter has xpath error")
    ]
    with pytest.raises(operations.FormNotValidated, match="Core runner never judged them"):
        _bar(core_runner, _form_filter(hq_test_app(), "#case/@status = 'open'"), unjudged=1)


def test_a_form_hq_stops_validating_on_its_own_error_is_excused_and_no_other(hq, core_runner):
    outcome, found = _bar(core_runner, _without_questions(hq_test_app()), unjudged=1)
    # Its case update now names answers it lacks, which HQ reports beside the blank form.
    assert {d.at for d in found if d.artifact == "validate_app@A"} == {
        "/modules/0/forms/1/blank form",
        "/modules/0/forms/1/path error",
    }
    with pytest.raises(operations.FormNotValidated):
        _bar(core_runner, _without_questions(hq_test_app()), unjudged=0)
