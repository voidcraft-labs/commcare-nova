"""The bar, on every Nova export: HQ builds it, and Core admits everything HQ generates.

Contract (plan work item 11, decision 16): for every corpus document, under
every configuration it is exported under, HQ accepts Nova's create and next
publish; ``validate_app()`` returns no error and raises nothing, and
``create_all_files()`` and each build profile's
``create_all_files(build_profile_id)`` succeed, for A, for B (the republish
of D) and for B-edit (the publish of D'); and the Core runner admits HQ's
build of each and every local archive Nova exported. A comparison cannot
see a defect both sides share (a condition HQ cannot build, a validation
Nova drops everywhere), so this holds each export to the bar directly.

Every difference must fall in a class of ``proof/known-defects.json``, and
so must every soft assertion HQ noted while it published and built: HQ notes
them and goes on, as production does (``proof.hq.boot``), so each is
evidence the register holds.

The document's records are made once for all its checks
(``observations.records_for``) and judged here (``bar.document_bar``).
"""

from __future__ import annotations

import pytest

from proof.checks import bar, cases, observations


@pytest.mark.parametrize("document", cases.document_params() + cases.control_params("bar"))
def test_every_export_meets_the_bar(document, hq, core_runner, editor_driver):
    found = bar.document_bar(document, observations.records_for(document, core_runner, editor_driver=editor_driver))
    cases.hold("bar", document, found, cases.load_register(), configurations=sorted(document.exports))


# HQ's notes ------------------------------------------------------------------------


def _records(**parts):
    from proof.observe.record import ConfigurationRecords, DocumentRecords

    records = DocumentRecords("doc", "corpus")
    records.configurations["minimum"] = ConfigurationRecords("minimum", {}, **parts)
    return records


NOTE = {"message": "phone datetime should never be empty", "value": "{}", "where": "casexml/util.py::check", "line": 7}


def _operation(label, **about):
    return {"label": label, **about, "wrote": False, "softAssertions": [NOTE]}


def test_each_note_hq_made_is_a_difference_of_the_check_whose_operation_made_it():
    request = {"hook": "proof4", "request": "ab" * 32, "softAssertions": [NOTE]}
    records = _records(
        a={"operations": [_operation("create"), _operation("flip", gate="toggle/X"), _operation("restore-a")]},
        b={"operations": [_operation("build"), _operation("unnamed")], "requests": [request]},
        b_aligned={"operations": [_operation("build-aligned"), _operation("case-processing:local.ccz")]},
        b_edit={"operations": [{"label": "publish", "wrote": True}, _operation("probe", hook="intent")]},
    )
    found = {
        check: {(d.artifact, d.path, d.kind) for d in observations.soft_assertion_differences(records, check)}
        for check in ("bar", "sensitivity", "proof2", "proof3", "intent", "proof4")
    }
    path = "/casexml~1util.py::check"
    assert found == {
        # An operation no check names is the bar's, so no note goes unheld.
        "bar": {
            ("soft_assert:create@A", path, "error"),
            ("soft_assert:build@B", path, "error"),
            ("soft_assert:unnamed@B", path, "error"),
        },
        "sensitivity": {("soft_assert:flip@A@toggle/X", path, "error")},
        "proof2": {("soft_assert:build-aligned@B", path, "error")},
        "proof3": {
            ("soft_assert:restore-a@A", path, "error"),
            ("soft_assert:case-processing:local.ccz@B", path, "error"),
        },
        # What a hook ran is the hook's: its operations, and its requests that noted something.
        "intent": {("soft_assert:probe@B-edit", path, "error")},
        "proof4": {(f"soft_assert:request:{'ab' * 8}@B", path, "error")},
    }
    (difference,) = [d for d in observations.soft_assertion_differences(records, "bar") if "@A" in d.artifact]
    assert difference.after == NOTE and difference.before is None
    # An operation that noted nothing is no difference.
    assert not any("publish" in artifact for check in found for artifact, _, _ in found[check])


def test_a_b_edit_recorded_as_b_shows_only_the_notes_of_the_operations_b_edit_runs():
    """A B-edit recorded as B's (``same_as``) reads B's ``b`` part, which holds exactly the operations B-edit's own
    observation runs; B's aligned build and proof 3's sessions are B's alone (``b_aligned``)."""
    records = _records(
        a={"operations": []},
        b={"operations": [_operation("build")]},
        b_aligned={"operations": [_operation("build-aligned"), _operation("case-processing:local.ccz")]},
        b_edit={"same_as": "00"},
    )
    found = sorted(
        d.artifact
        for check in ("bar", "proof2", "proof3")
        for d in observations.soft_assertion_differences(records, check)
    )
    assert found == [
        "soft_assert:build-aligned@B",
        "soft_assert:build@B",
        "soft_assert:build@B-edit",
        "soft_assert:case-processing:local.ccz@B",
    ]


# Nova's media upload -------------------------------------------------------------


def _published(media):
    return {"refused": None, "lookups": None, **({} if media is None else {"media": media})}


def _media(**report):
    return {"refused": None, "matched": [], "unmatched": [], "skipped": [], "errors": [], **report}


def _unmatched(path, cause, logo_refs=()):
    return {
        "path": path,
        "reason": "Did not match any Image paths in application.",
        "cause": cause,
        "logoRefs": list(logo_refs),
    }


def test_each_file_of_novas_media_upload_hq_did_not_map_is_the_bars_by_its_cause():
    """HQ's processing of the upload (``proof.observe.publish.upload_media``) maps each file the app references; a
    file matched everywhere, or a publish that sends no media, holds nothing. Each file it did not map is held by
    the cause the record names, never by HQ's reason, which is one for all of these, nor by the logos at its path.
    The edit bar holds only B-edit's upload: A's is the republish bar's, reported once."""
    matched = {"path": "jr://file/commcare/a.png", "class": "CommCareImage"}
    records = _records(
        a={"create": _published(_media(matched=[matched], unmatched=[_unmatched("commcare/a.png", "no_reference")]))},
        b={
            "publish": _published(
                _media(
                    unmatched=[
                        _unmatched("commcare/b.png", "other_type", ["hq_logo_android_home"]),
                        _unmatched("commcare/c.png", "logo_refs", ["hq_logo_web_apps"]),
                    ],
                    skipped=[{"path": "commcare/d.txt", "mimetype": "text/plain"}],
                    errors=["Error while processing zip: Bad CRC-32 for file 'commcare/e.png'"],
                )
            )
        },
        b_edit={"publish": _published({"refused": {"status": 404, "response": {"success": False}}})},
    )
    republish = bar.republish_bar("doc", observations.republish_view(records, "minimum"))
    assert sorted((d.artifact, d.path, d.at, d.kind) for d in republish) == [
        ("media@A", "/unmatched/*/no_reference", "/unmatched/commcare~1a.png/no_reference", "refused"),
        ("media@B", "/errors/*", "/errors/0", "error"),
        ("media@B", "/skipped/*", "/skipped/commcare~1d.txt", "refused"),
        ("media@B", "/unmatched/*/logo_refs", "/unmatched/commcare~1c.png/logo_refs", "refused"),
        ("media@B", "/unmatched/*/other_type", "/unmatched/commcare~1b.png/other_type", "refused"),
    ]
    edit = bar.edit_bar("doc", observations.edit_view(records, "minimum"))
    assert [(d.artifact, d.path, d.kind, d.after) for d in edit] == [
        ("media@B-edit", "/status/404", "refused", {"status": 404, "response": {"success": False}})
    ]
    without = _records(a={"create": _published(_media(matched=[matched]))}, b={"publish": _published(None)})
    assert bar.republish_bar("doc", observations.republish_view(without, "minimum")) == []


# Every check that holds notes reports them ---------------------------------------


def _reporting_calls(path):
    """Each check whose notes a module's functions report: calls ``soft_assertion_differences(records, <check>)``
    in a judge, or in a test function whose differences it holds to the register (``cases.hold``)."""
    import ast

    tree = ast.parse(path.read_text(encoding="utf-8"))
    constants = {
        target.id: node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
        for target in node.targets
        if isinstance(target, ast.Name)
    }

    def called(node, name):
        function = node.func
        return isinstance(node, ast.Call) and (getattr(function, "attr", None) or getattr(function, "id", None)) == name

    found = set()
    for function in ast.walk(tree):
        if not isinstance(function, ast.FunctionDef):
            continue
        calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)]
        if path.name.startswith("test_") and not any(called(node, "hold") for node in calls):
            continue
        for node in calls:
            if called(node, "soft_assertion_differences") and len(node.args) == 2:
                check = node.args[1]
                if isinstance(check, ast.Constant):
                    found.add(check.value)
                elif isinstance(check, ast.Name) and check.id in constants:
                    found.add(constants[check.id])
    return found


def test_every_check_an_operations_notes_are_held_by_reports_them():
    """A note is held by the check whose operation made it (``observations.operation_check``): the unit's own
    operations' checks, and each observation hook that exists (its operations and requests). Each such check
    reports the notes it holds, or they would be recorded and never reach the register: HQ notes them and goes on,
    as production does (``proof.hq.boot``), so each is evidence."""
    import importlib.util
    from pathlib import Path

    from proof.observe.unit import HOOKS

    hooks = {name for name, _, _ in HOOKS}
    present = {name for name in hooks if importlib.util.find_spec(f"proof.observe.{name}") is not None}
    # A hook's notes are held by the check named for it, or the one ``HOOK_CHECKS`` gives it (the served
    # hook's are proof 3's).
    present = {observations.HOOK_CHECKS.get(name, name) for name in present}
    holding = ({"bar", *observations.OPERATION_CHECKS.values()} - hooks) | present
    reported = set()
    for path in sorted(Path(observations.__file__).parent.glob("*.py")):
        if path.name != "observations.py":
            reported |= _reporting_calls(path)
    assert holding - reported == set(), (
        f"Notes HQ makes in operations of {sorted(holding - reported)} are recorded, and no judge of those checks"
        " reports them: have each such check's document judgment add"
        " observations.soft_assertion_differences(records, '<check>') to what it holds."
    )
    assert {"bar", "sensitivity", "proof2", "proof3"} <= reported
