"""A Save to Case update and Case Management write the same household property."""

from dataclasses import replace

from lxml import etree

from proof.formplayer import apps, hq as formplayer
from proof.formplayer.walk import questions, screen_kind
from proof.hq.check import hq_check
from proof.matrix.authoring import Authoring
from proof.observe import casedata, publish

BASE = "hq-case-management"
CASE_ID = "household-order"
CASE_NS = "{http://commcarehq.org/case/transaction/v2}"
AUTHORED = "From the authored block"
MANAGED = "From Case Management"


def _database(document):
    base = casedata.document_case_database(document)
    household = next(case for case in base.cases if case.case_type == "household")
    return replace(base, cases=(
        replace(household, case_id=CASE_ID, properties=(("note", "Original"),)),
    ))


def _open_followup(web):
    screen = web.navigate(["0"])
    if screen_kind(screen) == "entities":
        screen = web.navigate([*map(str, screen["selections"]), CASE_ID])
    assert screen_kind(screen) == "commands", screen
    ordinal = next(
        index for index, command in enumerate(screen["commands"]) if command["displayText"] == "Followup"
    )
    screen = web.navigate([*map(str, screen["selections"]), str(ordinal)])
    if screen_kind(screen) == "entities":
        assert [row["id"] for row in screen["entities"]] == [CASE_ID], screen
        screen = web.navigate([*map(str, screen["selections"]), CASE_ID])
    assert screen_kind(screen) == "form" and CASE_ID in screen["selections"], screen
    return screen


def _worker(unit, app_id, document, runner, stage, cases):
    from corehq.form_processor.models import CommCareCase

    observations = {}
    with formplayer.serve(unit, document, app_id, runner=runner, database=_database(document), label=stage) as served:
        for visited, notes, final, blocks in cases:
            with served.run(f"{stage}-{visited}"):
                web = apps.web(runner, served)
                form = _open_followup(web)
                fields = {node.get("binding"): node for node in questions(form["tree"])}
                assert {"/data/visited", "/data/new_member", "/data/member_left"} <= fields.keys(), fields
                selected = fields["/data/visited"]
                values = [choice.lower() for choice in selected["choices"]]
                assert set(values) == {"yes", "no"}, selected
                answers = {
                    fields["/data/new_member"]["ix"]: AUTHORED,
                    fields["/data/member_left"]["ix"]: "2",
                    selected["ix"]: str(values.index(visited) + 1),
                }
                if visited == "yes":
                    answers[fields["/data/visit_note"]["ix"]] = MANAGED
                sent = len(served.hq.submissions)
                reply = web.submit(form["session_id"], answers)
                assert reply["status"] == "success", reply
                submission, = served.hq.submissions[sent:]
                root = etree.fromstring(submission.instance)
                selected_blocks = [block for block in root.iter(f"{CASE_NS}case") if block.get("case_id") == CASE_ID]
                writes = [
                    value.text for block in selected_blocks for value in block.findall(f"{CASE_NS}update/{CASE_NS}note")
                ]
                assert writes == notes, etree.tostring(root)
                assert len(selected_blocks) == blocks, etree.tostring(root)
                observed = CommCareCase.objects.get_case(CASE_ID, served.domain)
                assert observed.get_case_property("note") == final
                observations[visited] = {
                    "writes": writes, "case": CASE_ID, "final": observed.get_case_property("note"),
                    "blocks": len(selected_blocks),
                }
    return observations


def test_an_authored_update_precedes_case_management_for_the_same_case(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence,
):
    from proof.matrix.ops import set_json
    from proof.matrix.registry import named_change

    document = formplayer_documents[BASE]
    configuration = document.exports["minimum"].configuration.hq()
    with hq_check(configuration) as (unit, _):
        with unit.operation("own-case-overlap:source", BASE.encode()):
            app_id, refusal, _ = publish.create_authored(unit, document)
            assert refusal is None
        ordinary = _worker(unit, app_id, document, formplayer_runner, "ordinary", [
            ("yes", [MANAGED], MANAGED, 1),
            ("no", [None], "", 1),
        ])
        authoring = Authoring(unit, {}, base=BASE, operation=unit.operation)
        named_change("save_to_case_own_case_beside")(authoring, app_id)
        paired = _worker(unit, app_id, document, formplayer_runner, "paired", [
            ("yes", [AUTHORED, MANAGED], MANAGED, 2),
            ("no", [AUTHORED, None], "", 2),
        ])
        # Remove the actual managed update and the unrelated basic subcase.
        # A blank managed row above is a different submission from no block.
        set_json(authoring, app_id, "/modules/0/forms/2/actions/update_case/condition/type", "never")
        set_json(authoring, app_id, "/modules/0/forms/2/actions/subcases", [])
        authored_only = _worker(unit, app_id, document, formplayer_runner, "authored-only", [
            ("no", [AUTHORED], AUTHORED, 1),
        ])
    evidence("own-case-overlap", {"ordinary": ordinary, "paired": paired, "authoredOnly": authored_only})
