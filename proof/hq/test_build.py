"""HQ's build runs whole, with every form judged by the Core runner.

Contract: ``operations.build`` runs HQ's ``validate_app()`` and
``create_all_files()`` under the build seams, and each form HQ asks
Formplayer to validate reaches the Core runner, in every build. The plausible
failures: a form HQ never sends (HQ caches a form's verdict per app and form
for seven days, so a second build of the same app would skip the runner),
and a seam that answers validation itself, so a form Core rejects still
builds clean.
"""

from __future__ import annotations

import json

import pytest
from lxml import etree

from proof.hq import operations
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.conftest import CountingValidator, hq_test_app, nova_shaped_upload, timed
from proof.hq.seams import build_seams

CONFIGURATION = Configuration(privileges={"CLOUDCARE"})
XFORMS = "http://www.w3.org/2002/xforms"


def _with_unbound_question(app_json):
    """The app with one question bound to a node its form's instance lacks."""
    first_form = app_json["modules"][0]["forms"][0]
    name = f"{first_form['unique_id']}.xml"
    tree = etree.fromstring(app_json["_attachments"][name].encode())
    body = next(el for el in tree.iter() if etree.QName(el).localname == "body")
    question = etree.SubElement(body, f"{{{XFORMS}}}input", ref="/data/not_in_the_instance")
    etree.SubElement(question, f"{{{XFORMS}}}label").text = "Unbound"
    app_json["_attachments"][name] = etree.tostring(tree, encoding="unicode")
    return app_json


def test_hq_builds_the_app_with_every_form_validated_by_core(hq, core_runner):
    validator = CountingValidator(core_runner)
    with hq_check(CONFIGURATION, validate=validator) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        forms = len(list(operations.held_app(state, app_id).get_forms()))
        assert validator.calls == 0  # the app maps no media, so its import validated nothing

        with build_seams():
            with timed("build_hq_test_app"):
                built = operations.build(operations.held_app(state, app_id), record)
            assert validator.calls == forms == 2
            assert built.errors == []
            assert {
                "profile.xml",
                "suite.xml",
                "media_suite.xml",
                "en/app_strings.txt",
                "modules-0/forms-0.xml",
                "modules-0/forms-1.xml",
            } <= set(built.files)
            assert all(v.response["validated"] for v in built.form_validations)

            # A second build of the app HQ holds sends every form again.
            with timed("build_hq_test_app"):
                operations.build(operations.held_app(state, app_id), record)
            assert validator.calls == 2 * forms


def test_a_form_core_rejects_fails_hqs_build(hq, core_runner):
    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(_with_unbound_question(hq_test_app()), "Suite app")])

        with build_seams():
            built = operations.build(operations.held_app(state, app_id), record)

    rejected = [v.response for v in built.form_validations if not v.response["validated"]]
    assert len(rejected) == 1 and "not_in_the_instance" in rejected[0]["fatal_error"]
    # HQ reports Core's verdict as a build error on that form.
    messages = [error.get("validation_message") or "" for error in built.errors]
    assert any("not_in_the_instance" in message for message in messages), built.errors


def _update_keeping_ids(app_json, held_form_ids, changed_form):
    """The app as an update that keeps HQ's form ids, with one form's label changed."""
    forms = [f for m in app_json["modules"] for f in m["forms"]]
    for index, (form, held_id) in enumerate(zip(forms, held_form_ids, strict=True)):
        source = app_json["_attachments"].pop(f"{form['unique_id']}.xml")
        if index == changed_form:
            tree = etree.fromstring(source.encode())
            text = next(el for el in tree.iter() if etree.QName(el).localname == "value" and el.text)
            text.text = text.text + " (changed)"
            source = etree.tostring(tree, encoding="unicode")
        form["unique_id"] = held_id
        app_json["_attachments"][f"{held_id}.xml"] = source
    return app_json


def test_the_previous_build_decides_which_forms_get_a_new_version(hq, core_runner):
    with hq_check(CONFIGURATION, validate=core_runner.validate_form) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        with build_seams(previous=None):
            build_a = operations.build(operations.held_app(state, app_id), record)
        a_version = build_a.app.version
        held_ids = [f.unique_id for f in build_a.app.get_forms()]
        saved_a = build_a.saved_build()

        update = _update_keeping_ids(hq_test_app(), held_ids, changed_form=1)
        result = operations.apply_upload(
            state, operations.with_app_id(nova_shaped_upload(update, "Suite app", app_id="captured"), app_id)
        )
        assert result.status == 200

        with build_seams(previous=saved_a):
            build_b = operations.build(operations.held_app(state, app_id), record)
        with build_seams(previous=None):
            first_build = operations.build(operations.held_app(state, app_id), record)

    b_version = build_b.app.version
    assert b_version > a_version
    # The unchanged form keeps A's version; the changed one takes B's.
    assert [f.get_version() for f in build_b.app.get_forms()] == [a_version, b_version]
    # Without a previous build every form takes the app's version.
    assert [f.get_version() for f in first_build.app.get_forms()] == [b_version, b_version]


# Core's answers kept by the form's bytes ------------------------------------------------------------
#
# Contract: Core's form validation is a function of the bytes HQ posts, so
# the validate seam answers bytes it has seen with the answer it kept
# (``proof.hq.seams.FORM_VALIDATIONS``), still recording every form HQ sends,
# and with PROOF_VERIFY_MEMOS=1 it computes every kept answer again. The
# plausible failures: a send left out of the record (so ``FormNotValidated``
# misses a form), an answer kept for a validator that also checks or counts
# what HQ sends, and a kept answer that differs from Core's, which only the
# verify mode can see.
#
# The lane switches the memo on with the speed seams (``proof.hq.speed``);
# these tests switch it on themselves, so they hold with PROOF_HQ_SPEED=0 too.


@pytest.fixture
def memo(monkeypatch):
    from proof.hq.seams import FORM_VALIDATIONS

    monkeypatch.setattr(FORM_VALIDATIONS, "enabled", True)
    FORM_VALIDATIONS.clear()
    try:
        yield FORM_VALIDATIONS
    finally:
        FORM_VALIDATIONS.clear()


def _two_builds(validate):
    with hq_check(CONFIGURATION, validate=validate) as (state, record):
        app_id, _ = operations.publish(state, [nova_shaped_upload(hq_test_app(), "Suite app")])
        with build_seams():
            first = operations.build(operations.held_app(state, app_id), record)
            second = operations.build(operations.held_app(state, app_id), record)
    return first, second


def test_cores_answer_to_bytes_it_validated_is_kept_and_every_send_is_recorded(hq, core_runner, memo, monkeypatch):
    hits = memo.hits
    first, second = _two_builds(core_runner.validate_form)
    assert len(first.form_validations) == len(second.form_validations) == 2
    assert memo.hits - hits == 2
    assert [v.response for v in second.form_validations] == [v.response for v in first.form_validations]

    # A validator that counts what HQ sends is asked every time.
    counting = CountingValidator(core_runner)
    _two_builds(counting)
    assert counting.calls == 4

    # With the memo off, as PROOF_HQ_SPEED=0 leaves it, Core is asked for every send.
    monkeypatch.setattr(memo, "enabled", False)
    hits = memo.hits
    _two_builds(core_runner.validate_form)
    assert memo.hits == hits


def test_verify_mode_computes_every_kept_answer_again_and_refuses_a_different_one(hq, core_runner, memo, monkeypatch):
    from proof.hq.seams import MemoMismatch, pure

    monkeypatch.setattr(memo, "verify", True)
    verified = memo.verified
    _two_builds(core_runner.validate_form)
    assert memo.verified - verified == 2

    # A validator marked pure whose second answer for the same bytes differs.
    seen = set()

    def changing(xml):
        answer = core_runner.validate_form(xml)
        if xml in seen:
            return json.dumps({"validated": False, "fatal_error": "a different answer", "problems": []})
        seen.add(xml)
        return answer

    memo.clear()
    with pytest.raises(MemoMismatch, match="a different answer"):
        _two_builds(pure(changing))

    # Without the verify mode the kept answer stands, which is why the mode exists.
    memo.clear()
    seen.clear()
    monkeypatch.setattr(memo, "verify", False)
    first, second = _two_builds(pure(changing))
    assert all(v.response["validated"] for v in second.form_validations)


# A form whose constraint Core's parser stops on: Core's message names the parser node it stopped at by its JVM
# identity hash ("Bad node: " and the node's ``Object.toString``, ``xpath/parser/Parser.java::verifyBaseExpr``).
BAD_NODE_FORM = b"""<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"
 xmlns:xsd="http://www.w3.org/2001/XMLSchema"><h:head><h:title>N</h:title><model>
 <instance><data xmlns="http://example.org/n"><n/></data></instance>
 <bind nodeset="/data/n" type="xsd:int" constraint=". &gt; "/></model></h:head>
 <h:body><input ref="/data/n"><label>N</label></input></h:body></h:html>"""


def test_verify_mode_holds_a_kept_answer_to_cores_own_again_but_for_the_identity_hashes_it_names_nodes_by(
    core_runner, memo, monkeypatch
):
    """Core answers the same bytes with another message each time where it names a parser node, so the verify
    mode compares a kept answer with Core's again without those hashes, and the kept answer stands."""
    from proof.hq.seams import IDENTITY_HASH

    once, again = core_runner.validate_form(BAD_NODE_FORM), core_runner.validate_form(BAD_NODE_FORM)
    assert IDENTITY_HASH.search(once) and once != again, (once, again)
    assert IDENTITY_HASH.sub(r"\1", once) == IDENTITY_HASH.sub(r"\1", again)

    monkeypatch.setattr(memo, "verify", True)
    verified = memo.verified
    kept = memo.answer(core_runner.validate_form, BAD_NODE_FORM)
    assert memo.answer(core_runner.validate_form, BAD_NODE_FORM) == kept
    assert memo.verified - verified == 1
