"""Stock Case Management and signed worker forms over the retained mixed writers."""

from dataclasses import replace

from lxml import etree

from proof.formplayer import apps, hq as formplayer
from proof.formplayer.walk import questions, screen_kind
from proof.hq import operations
from proof.hq.check import hq_check
from proof.matrix import ops
from proof.matrix.authoring import Authoring
from proof.matrix.bases import _pages
from proof.observe import casedata, publish

BASE = "hq-case-management"
HOUSEHOLD = "mixed-members"
CASE_NS = "{http://commcarehq.org/case/transaction/v2}"


def _prepare(state, document):
    with state.operation("mixed-members:source", BASE.encode()):
        app_id, refusal, _ = publish.create_authored(state, document)
        assert refusal is None
    authoring = Authoring(state, {}, base=BASE, operation=state.operation)
    _pages.delete_form(authoring, app_id, 0, 3)
    _pages.turn_web_apps_on(authoring, app_id)
    # The Basic Case Management page retains, but does not offer an author a
    # control to add, a historical case preload. The retained variant has it.
    preload = {"/data/village_seen": "village", "/data/members": "members"}
    ops.set_json(authoring, app_id, "/modules/0/forms/1/actions/case_preload/preload", preload)
    _pages.save_case_management(authoring, app_id, 0, 1)
    _pages.save_case_management(
        authoring, app_id, 0, 2,
        diff={"update_case": {"add": {"members": [{"question_path": "/data/visit_note", "update_mode": "always"}]}}},
    )
    numeric, text = operations.held_app(state, app_id).get_module(0).forms[1:3]
    assert dict(numeric.actions.case_preload.preload) == preload
    assert numeric.actions.update_case.update["members"].question_path == "/data/members"
    assert numeric.actions.update_case.update["members"].update_mode == "edit"
    assert text.actions.update_case.update["members"].question_path == "/data/visit_note"
    return app_id


def _database(document):
    seed = casedata.document_case_database(document)
    row = next(case for case in seed.cases if case.case_type == "household")
    return replace(seed, cases=(replace(row, case_id=HOUSEHOLD, properties=(("members", "3"), ("village", "west"))),))


def _open(web, name):
    screen = web.navigate(["0"])
    if screen_kind(screen) == "entities":
        screen = web.navigate([*map(str, screen["selections"]), HOUSEHOLD])
    assert screen_kind(screen) == "commands", screen
    ordinal = next(i for i, command in enumerate(screen["commands"]) if command["displayText"] == name)
    screen = web.navigate([*map(str, screen["selections"]), str(ordinal)])
    if screen_kind(screen) == "entities":
        assert [row["id"] for row in screen["entities"]] == [HOUSEHOLD], screen
        screen = web.navigate([*map(str, screen["selections"]), HOUSEHOLD])
    return screen


def _fields(screen):
    assert screen_kind(screen) == "form" and HOUSEHOLD in screen["selections"], screen
    return {q["binding"]: q for q in questions(screen["tree"])}


def _submit(served, web, screen, answers, expected):
    from corehq.form_processor.models import CommCareCase

    sent = len(served.hq.submissions)
    reply = web.submit(screen["session_id"], answers)
    assert reply["status"] == "success", reply
    submission, = served.hq.submissions[sent:]
    root = etree.fromstring(submission.instance)
    writes = [
        item.text for node in root.iter(f"{CASE_NS}case") if node.get("case_id") == HOUSEHOLD
        for item in node.findall(f"{CASE_NS}update/{CASE_NS}members")
    ]
    assert writes == [expected], etree.tostring(root)
    case = CommCareCase.objects.get_case(HOUSEHOLD, served.domain)
    assert case.get_case_property("members") == expected
    return writes


def test_case_management_preserves_mixed_writers_and_reopens_the_number(hq, formplayer_runner, formplayer_documents, evidence):
    document = formplayer_documents[BASE]
    config = document.exports["minimum"].configuration.hq()
    config = replace(config, privileges=config.privileges | {"CLOUDCARE"})
    observed = {}
    with hq_check(config) as (state, _):
        app_id = _prepare(state, document)
        with formplayer.serve(state, None, app_id, runner=formplayer_runner, database=_database(document)) as served:
            with served.run("number-write"):
                web = apps.web(formplayer_runner, served)
                screen = _open(web, "Followup Form")
                fields = _fields(screen)
                assert fields["/data/members"]["datatype"] == "int", fields
                observed["originalStartingAnswer"] = fields["/data/members"].get("answer")
                observed["numberWrite"] = _submit(served, web, screen, {fields["/data/members"]["ix"]: "8"}, "8")
            for value in ("7", "007", "7.5", "several"):
                with served.run(f"text-write-{value}"):
                    web = apps.web(formplayer_runner, served)
                    screen = _open(web, "Followup")
                    fields = _fields(screen)
                    visited = fields["/data/visited"]
                    choices = [text.lower() for text in visited["choices"]]
                    _submit(served, web, screen, {
                        visited["ix"]: str(choices.index("yes") + 1),
                        fields["/data/visit_note"]["ix"]: value,
                        fields["/data/new_member"]["ix"]: "New member",
                        fields["/data/member_left"]["ix"]: "2",
                    }, value)
                    # Reopen from a fresh restore after HQ commits the text.
                    web = apps.web(formplayer_runner, served)
                    next_screen = _open(web, "Followup Form")
                    if screen_kind(next_screen) == "form":
                        question = _fields(next_screen)["/data/members"]
                        observed[value] = {"datatype": question["datatype"], "answer": question.get("answer")}
                    else:
                        observed[value] = {"kind": screen_kind(next_screen), "error": next_screen.get("error")}
    assert observed["originalStartingAnswer"] in (3, "3"), observed
    assert observed["7"].get("answer") in (7, "7"), observed
    evidence("mixed-members", observed)
