"""Observe saved property values through Vellum, Formplayer, and the HQ case receiver."""

from dataclasses import replace

import pytest
from lxml import etree

from proof.editors import vellum
from proof.editors.conftest import corpus_document, write_evidence
from proof.formplayer import apps, hq as formplayer
from proof.formplayer.test_lookup_tags import _opened, _questions
from proof.formplayer.walk import screen_kind
from proof.hq import operations
from proof.hq.check import hq_check
from proof.matrix.authoring import Authoring
from proof.matrix import registry
from proof.observe import casedata, publish

CASE = "{http://commcarehq.org/case/transaction/v2}"
MODEL = "{http://www.w3.org/2002/xforms}"
STAMP = "2025-12-01T08:00:00.000Z"
NEIGHBORS = (
    casedata.CaseRecord("held-blue", "patient", "Unparsed text", casedata.USER_ID, STAMP, STAMP, None, (("kept", "blue"),)),
    casedata.CaseRecord("held-number", "patient", "Numeric text", casedata.USER_ID, STAMP, STAMP, None, (("kept", "007"),)),
    casedata.CaseRecord("held-date", "patient", "Date text", casedata.USER_ID, STAMP, STAMP, None, (("kept", "2025-12-01"),)),
)
DATABASE = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), NEIGHBORS)


def _operations(source):
    root = etree.fromstring(source.encode())
    return {
        bind.get("nodeset"): bind.get("calculate")
        for bind in root.iter(f"{MODEL}bind")
        if (bind.get("nodeset") or "").startswith("/data/nova_operations/")
        and bind.get("nodeset").endswith(("update/kept", "update/case_type", "again/case/@case_id"))
    }


def _changes(instance):
    changes = {}
    for label in ("mk", "again"):
        block, = instance.xpath(
            "//*[local-name()='nova_operations']/*[local-name()=$label]/*[local-name()='case']",
            label=label,
        )
        changes[label] = {
            "id": block.get("case_id"),
            "type": block.findtext(f"{CASE}update/{CASE}case_type") or block.findtext(f"{CASE}create/{CASE}case_type"),
            "kept": [node.text or "" for node in block.findall(f"{CASE}update/{CASE}kept")],
        }
    case_id = changes["mk"]["id"]
    assert case_id and case_id == changes["again"]["id"]
    assert case_id not in {row.case_id for row in NEIGHBORS}
    return changes


def _submitted(unit, document, app_id, runner, *, full_name, visit_date, must_answer_date=False):
    from corehq.form_processor.models import CommCareCase

    with formplayer.serve(
        unit, document, app_id, runner=runner, label="retype-fresh-case", database=DATABASE,
    ) as served, served.run("retype-fresh-case"):
        web = apps.web(runner, served)
        screen = _opened(web)
        assert screen_kind(screen) == "form", screen
        question_map = {question.get("binding"): question for question in _questions(screen["tree"])}
        answers = {question_map["/data/full_name"]["ix"]: full_name}
        date_question = question_map["/data/visit_date"]
        if visit_date is not None:
            answers[date_question["ix"]] = visit_date
        reply = web.submit(screen["session_id"], answers, prevalidated=not must_answer_date)
        if must_answer_date and visit_date is None:
            return {
                "status": reply.get("status"),
                "required": date_question.get("required"),
                "submissions": len(served.hq.submissions),
            }
        assert reply.get("status") == "success", reply
        submission, = served.hq.submissions
        changes = _changes(etree.fromstring(submission.instance))
        case_id = changes["mk"]["id"]
        final = CommCareCase.objects.get_case(case_id, unit.domain)
        neighbors = {
            row.case_id: {"type": case.type, "properties": case.case_json}
            for row in NEIGHBORS
            if (case := CommCareCase.objects.get_case(row.case_id, unit.domain))
        }
        return {
            "changes": changes,
            "final": {"type": final.type, "properties": final.case_json},
            "neighbors": neighbors,
        }


def _prepare(unit, document, direction, editor_driver):
    with unit.operation("retype:authored-base", direction.encode()):
        app_id, refusal, _ = publish.create_authored(unit, document)
        assert refusal is None
    authoring = Authoring(unit, {}, base=document.id, driver=editor_driver, operation=unit.operation)
    change = "save_to_case_date_as_text" if direction == "date-to-text" else "save_to_case_retype_converts"
    registry.named_change(change)(authoring, app_id)
    form = operations.held_app(unit, app_id).modules[0].forms[0]
    before = _operations(form.source)
    edit = (
        {"way": "builder-model", "path": "/data/visit_date", "property": "requiredAttr", "value": True}
        if direction == "required-date" else None
    )
    saved = vellum.fresh_open_and_save(editor_driver, unit, app_id, form.unique_id, edit=edit)
    after = _operations(saved.stored_source) if saved.stored_source else {}
    receipt = {"before": before, "after": after, "loaded": saved.loaded, "saved": saved.saved,
               "loadError": saved.load_error, "saveRefusal": saved.save_refusal, "formErrors": saved.form_errors}
    write_evidence(f"save-to-case-retype-{direction}", receipt)
    assert saved.loaded and saved.saved and not saved.page_errors, receipt
    assert before == after, receipt
    if direction == "required-date":
        root = etree.fromstring(saved.stored_source.encode())
        (date_bind,) = root.xpath("//*[local-name()='bind' and @nodeset='/data/visit_date']")
        assert date_bind.get("required") == "true()"
    return app_id, receipt


@pytest.mark.parametrize("direction", ["text-to-date", "date-to-text", "required-date"])
def test_vellum_and_signed_worker_retype_a_fresh_case_with_an_explicit_overwrite(
    hq, editor_driver, formplayer_runner, direction,
):
    document = corpus_document("hq-questions")
    configuration = document.exports["minimum"].configuration.hq()
    configuration = replace(configuration, privileges=configuration.privileges | {"VELLUM_SAVE_TO_CASE"})
    with hq_check(configuration) as (unit, _):
        app_id, receipt = _prepare(unit, document, direction, editor_driver)
        if direction == "required-date":
            receipt["missing"] = _submitted(
                unit, document, app_id, formplayer_runner, full_name="blue",
                visit_date=None, must_answer_date=True,
            )
            write_evidence(f"save-to-case-retype-{direction}", receipt)
            assert receipt["missing"]["required"] == 1, receipt
            assert receipt["missing"]["status"] != "success" and receipt["missing"]["submissions"] == 0, receipt

        scenarios = {"dated": ("blue", "2025-12-01")}
        if direction == "text-to-date":
            scenarios |= {"blank-date": ("blue", None), "date-text-to-date": ("2025-11-14", "2025-12-01")}
        for name, (full_name, visit_date) in scenarios.items():
            # Each submission starts from the same existing rows. Native
            # Formplayer generates the case ID and HQ commits the case blocks.
            receipt[name] = _submitted(
                unit, document, app_id, formplayer_runner, full_name=full_name,
                visit_date=visit_date, must_answer_date=direction == "required-date",
            )
        write_evidence(f"save-to-case-retype-{direction}", receipt)

    for name, (full_name, visit_date) in scenarios.items():
        result = receipt[name]
        assert result["changes"]["mk"]["type"] == "patient"
        assert result["changes"]["again"]["type"] == "visit"
        first, final = (full_name, visit_date or "") if direction != "date-to-text" else (visit_date, full_name)
        assert result["changes"]["mk"]["kept"] == [first]
        assert result["changes"]["again"]["kept"] == [final]
        assert result["final"] == {"type": "visit", "properties": {"kept": final}}
        assert result["neighbors"] == {
            row.case_id: {"type": row.case_type, "properties": dict(row.properties)} for row in NEIGHBORS
        }


@pytest.mark.reader("android")
def test_signed_android_requires_the_date_and_overwrites_the_fresh_case(hq, editor_driver, monkeypatch):
    from corehq.form_processor.models import CommCareCase

    from proof.android import observe
    from proof.android.hq import DevicePeer
    from proof.observe.record import Blobs

    day, command = "2025-12-01", "m0-f0"
    document = corpus_document("hq-questions")
    configuration = document.exports["minimum"].configuration.hq()
    configuration = replace(configuration, privileges=configuration.privileges | {"VELLUM_SAVE_TO_CASE"})
    expected_neighbors = {row.case_id: (row.case_type, dict(row.properties)["kept"]) for row in NEIGHBORS}
    hq_neighbors = {}
    original_stored = DevicePeer._stored

    def stored_with_properties(peer, submissions):
        receipts = original_stored(peer, submissions)
        for receipt in receipts:
            for case_id, case in receipt.get("cases", {}).items():
                case["properties"] = CommCareCase.objects.get_case(case_id, peer.served.domain).case_json
            for case_id in expected_neighbors:
                neighbor = CommCareCase.objects.get_case(case_id, peer.served.domain)
                hq_neighbors[case_id] = (neighbor.type, neighbor.case_json["kept"])
        return receipts

    monkeypatch.setattr(DevicePeer, "_stored", stored_with_properties)
    with hq_check(configuration) as (unit, _):
        app_id, receipt = _prepare(unit, document, "required-date", editor_driver)
        with formplayer.serve(unit, document, app_id, database=DATABASE, platforms={"android"}) as served:
            archive = observe.release_archive(served)
            for label, answer in (("blank", []), ("dated", [f"calendar:{day}"])):
                blobs, sent, stored = Blobs(), [], []
                result = observe.app(
                    served, blobs, label=f"retype-{label}", archive=archive, delivered=True,
                    commands=[command], questions={"/data/full_name": ["blue"], "/data/visit_date": answer},
                    sent=sent, stored=stored, installation_languages=("en",), views=True,
                )
                walk = blobs.get_json(result["answer"])["walks"][command]
                receipt[label] = {"walk": walk, "sent": len(sent), "stored": stored, "hqNeighbors": hq_neighbors}
                write_evidence("save-to-case-retype-required-date-android", receipt)
                form, = [step["form"] for step in walk["steps"] if step.get("screen") == "FormEntryActivity"]
                date_screens = [
                    question for screen in form["screens"] for question in screen["questions"]
                    if question["reference"] == "/data/visit_date"
                ]
                assert date_screens and all(question["required"] for question in date_screens), form
                if label == "blank":
                    assert all(question["answer"] is None for question in date_screens), date_screens
                    assert form["saved"]["finishing"] is False and form["saved"]["casesAsTheFormOpened"], form
                    assert not sent and not stored, receipt[label]
                    continue

                assert form["saved"]["finishing"] is True, form
                submission, = sent
                kept, = stored
                assert kept["form"]["normal"], kept
                changes = _changes(etree.fromstring(submission))
                assert _changes(etree.fromstring(kept["form"]["xml"].encode())) == changes
                assert [(change["type"], change["kept"]) for change in changes.values()] == [
                    ("patient", ["blue"]), ("visit", [day]),
                ], changes
                final, = [row for row in form["saved"]["cases"] if row["id"].startswith("@device-case:")]
                assert final["type"] == "visit" and final["properties"]["kept"] == day, final
                assert {
                    row["id"]: (row["type"], row["properties"]["kept"])
                    for row in form["saved"]["cases"] if row["id"] in expected_neighbors
                } == expected_neighbors
                assert hq_neighbors == expected_neighbors
                assert kept["cases"] == {
                    changes["again"]["id"]: {
                        "name": "blue", "type": "visit", "forms": [kept["instanceID"]], "properties": {"kept": day},
                    },
                }, kept


def test_hq_type_only_retype_retains_raw_values_on_existing_cases(hq):
    from casexml.apps.case.mock import CaseBlock
    from corehq.apps.hqcase.utils import submit_case_blocks
    from corehq.form_processor.models import CommCareCase

    from proof.hq import redis as hq_redis
    from proof.hq.configuration import Configuration

    def rows(state):
        return {
            row.case_id: {"type": case.type, "properties": case.case_json}
            for row in NEIGHBORS
            if (case := CommCareCase.objects.get_case(row.case_id, state.domain))
        }

    with hq_check(Configuration()) as (unit, _):
        with hq_redis.shared(None), unit.committing():
            with unit.operation("retype:existing-seed", b"existing-values"):
                seeds = [
                    CaseBlock(
                        case_id=row.case_id, create=True, case_type=row.case_type, case_name=row.name,
                        owner_id="worker", update={**dict(row.properties), "unrelated": row.name},
                    ).as_text()
                    for row in NEIGHBORS
                ]
                submit_case_blocks(seeds, unit.domain, user_id="worker", device_id="proof")
                before = rows(unit)
            with unit.operation("retype:existing-submit", b"existing-values"):
                type_only = [
                    CaseBlock(case_id=case_id, update={"case_type": "visit"}).as_text()
                    for case_id in ("held-blue", "held-number")
                ]
                submit_case_blocks(type_only, unit.domain, user_id="worker", device_id="proof")
                after = rows(unit)
    write_evidence("case-retype-existing-values", {"before": before, "after": after})
    assert before == {
        row.case_id: {"type": "patient", "properties": {**dict(row.properties), "unrelated": row.name}}
        for row in NEIGHBORS
    }
    assert after == {
        case_id: {**case, "type": "patient" if case_id == "held-date" else "visit"}
        for case_id, case in before.items()
    }
