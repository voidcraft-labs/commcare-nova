"""HQ's XPath validator answers from one long-lived child exactly as from a node process per expression.

Contract: ``proof.hq.speed.XPATH`` returns HQ's own ``validate_xpath``'s
``(is_valid, message)``, byte for byte, for every expression, with and without
case hashtags, and every binding HQ's build and views call reaches it. The
plausible failures: input handled differently from the wrapper (its
whitespace collapse, its UTF-8 bytes on node's standard input, carriage
returns), a message printed differently from ``console.log`` (non-ASCII text,
an error without a message), state one parse leaves for the next in the
long-lived child (so answers depend on the order expressions arrive in), a
binding left on HQ's spawn path, and a child that dies or hangs swallowed as
an invalid expression.

The expressions are every one HQ's validator was sent while the lane ran its
24-document baseline sample, and every module filter, form filter and case
search expression the whole emitted corpus's uploads carry
(``xpath/expressions.json``, each with the flag it is sent with), each also
sent with the other flag, and a fixed list of invalid and unusual ones. They
are asked in order and again in reverse, since the child is long-lived.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from proof.hq import speed

EXPRESSIONS = Path(__file__).resolve().parent / "xpath" / "expressions.json"

# Invalid and unusual expressions, each sent with and without case hashtags.
FIXED = [
    "",
    " ",
    "#case/@case_id = ''",
    "#case/name = 'a'",
    "#parent/name",
    "#host/name",
    "#session/userid = ''",
    "#user/name",
    "#unknown/name = 1",
    "#form/question",
    "#case/",
    "1 +",
    "1 = = 2",
    "not(",
    "count(/data/repeat",
    "/data/q = 'unterminated",
    "/data/q[",
    "]",
    "@case_id",
    "$value = 1",
    "if(true(), 1)",
    "1 div 0",
    "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/name",
    "concat('é', '€') +",
    "'😀' =",
    "' ' = 1 +",
    "true()\r\nand\tfalse()",
    "a\x85b = 1",
    "/data/a\r= 1",
]


def _cases():
    recorded = json.loads(EXPRESSIONS.read_text())["expressions"]
    assert recorded, f"{EXPRESSIONS} lists no expressions, so the comparison proves nothing about the corpus"
    cases = []
    for entry in recorded:
        for flag in (entry["caseHashtags"], not entry["caseHashtags"]):
            cases.append((entry["xpath"], flag))
    for xpath in FIXED:
        cases += [(xpath, False), (xpath, True)]
    return cases


def test_every_expression_gets_hqs_own_answer_in_any_order(hq):
    spawn = speed.hq_validate_xpath()
    assert spawn.__module__ == "corehq.apps.app_manager.xpath_validator.wrapper" and spawn is not speed.XPATH
    cases = _cases()
    expected = [tuple(spawn(xpath, flag)) for xpath, flag in cases]
    forward = [tuple(speed.XPATH(xpath, flag)) for xpath, flag in cases]
    backward = [tuple(speed.XPATH(xpath, flag)) for xpath, flag in reversed(cases)][::-1]
    mismatched = [(case, want, got) for case, want, got in zip(cases, expected, forward, strict=True) if want != got]
    assert mismatched == []
    assert backward == expected
    assert {valid for valid, _ in expected} == {True, False}
    assert any(message and not message.isascii() for _, message in expected)


def test_every_binding_hqs_build_and_views_call_reaches_the_child(hq):
    from corehq.apps.app_manager import xpath_validator
    from corehq.apps.app_manager.helpers import validators
    from corehq.apps.app_manager.views import modules
    from corehq.apps.app_manager.xpath_validator import wrapper

    def bindings():
        return {
            wrapper.validate_xpath,
            xpath_validator.validate_xpath,
            validators.validate_xpath,
            modules.validate_xpath,
        }

    with speed.on():
        assert bindings() == {speed.XPATH}
    with speed.off():
        assert bindings() == {speed.hq_validate_xpath()} != {speed.XPATH}


def test_a_build_reads_the_same_filter_errors_from_either(hq, core_runner):
    """HQ's own build, with a module filter and a form filter it refuses, lists the same errors either way."""
    from proof.hq import operations
    from proof.hq.check import hq_check
    from proof.hq.configuration import Configuration
    from proof.hq.conftest import hq_test_app, nova_shaped_upload

    app_json = hq_test_app()
    app_json["modules"][0]["module_filter"] = "#case/@case_id = ''"
    app_json["modules"][0]["forms"][0]["form_filter"] = "count(/data/repeat"
    with hq_check(Configuration()) as (state, _):
        app_id, _ = operations.publish(state, [nova_shaped_upload(app_json, "Suite app")])
        with speed.on():
            seamed = operations.held_app(state, app_id).validate_app()
        with speed.off():
            spawned = operations.held_app(state, app_id).validate_app()
    filter_errors = [error for error in seamed if "xpath_error" in error]
    assert len(filter_errors) == 2, seamed
    assert seamed == spawned


def test_the_child_starts_on_first_use_and_a_stopped_child_starts_again(hq):
    speed.stop_children()
    assert not speed.XPATH.running
    assert speed.XPATH("true()").is_valid
    assert speed.XPATH.running
    speed.stop_children()
    assert not speed.XPATH.running
    assert speed.XPATH("true()").is_valid


def test_a_child_that_cannot_answer_ends_the_check_with_what_node_said(hq, tmp_path, monkeypatch):
    broken = tmp_path / "server.mjs"
    broken.write_text('throw new Error("proof: this validator cannot start");\n')
    monkeypatch.setattr(speed, "XPATH_SERVER", broken)
    validator = speed.XPathValidator()
    try:
        with pytest.raises(speed.XPathValidatorFailed, match="this validator cannot start"):
            validator("true()")
        assert not validator.running
    finally:
        validator.close()
    monkeypatch.undo()
    accepted = speed.XPathValidator()
    try:
        assert accepted("true()").is_valid
    finally:
        accepted.close()
