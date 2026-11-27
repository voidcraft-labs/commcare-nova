"""Native Formplayer runs the three pragmas and repeat starting values Nova emits."""

import io
import zipfile

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import questions, screen_kind

DOCUMENT = "targeted-form-behavior-pragmas"


def _form(web, command):
    response = web.navigate(["0", str(command)])
    assert screen_kind(response) == "form", response.get("notification") or response
    return response


def _answers(form):
    return {item["caption"]: item["ix"] for item in questions(form["tree"]) if "caption" in item}


def test_navigation_submits_automatically_and_a_separate_pragma_suppresses_configured_sync(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence,
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner, "maximum") as published, published.unit.fork():
        # Nova ordinarily emits no post-form sync. HQ's own setting supplies a
        # control in which the suppression flag can actually make a difference.
        apps.saved_profile(published, custom_properties={"cc-sync-after-form": "yes"})
        with apps.served(published, formplayer_runner) as served:
            with zipfile.ZipFile(io.BytesIO(served.archive())) as archive:
                profile = etree.fromstring(archive.read("profile.ccpr"))
            assert profile.xpath("//*[local-name()='property' and @key='cc-sync-after-form']/@value") == ["yes"]
            observations = []
            scenarios = (
                (0, True, True, "Automatic report"),
                (1, False, True, "Manual report"),
                (5, False, False, "Manual report"),
            )
            for command, automatic, should_sync, expected in scenarios:
                with served.run(f"post-form-sync-{command}"):
                    web = apps.web(formplayer_runner, served)
                    menu = web.navigate(["0"])
                    assert screen_kind(menu) == "commands", menu
                    restores = len([item for item in served.hq.exchanges if "/restore/" in item.path])
                    assert restores > 0
                    before = len(served.hq.submissions)
                    if automatic:
                        # Pinned MenuController handles automatic submission
                        # during navigation, before the client opens a form.
                        outcome = web.navigate(["0", str(command)])
                        assert screen_kind(outcome) != "form", outcome
                    else:
                        form = _form(web, command)
                        assert len(served.hq.submissions) == before
                        outcome = web.submit(form["session_id"], {_answers(form)["Visit note"]: expected})
                    assert outcome["status"] == "success", outcome
                    received, = served.hq.submissions[before:]
                    assert etree.fromstring(received.instance).findtext("{*}note") == expected
                    after = len([item for item in served.hq.exchanges if "/restore/" in item.path])
                    assert after - restores == int(should_sync), served.hq.exchanges
                    observations.append({"automatic": automatic, "postFormRestores": after - restores, "answer": expected})
            evidence("form-pragmas", observations)


def test_the_walk_records_the_automatic_visit_as_submitted(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence,
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published, apps.served(
        published, formplayer_runner,
    ) as served:
        trace = apps.walked(formplayer_runner, served, [[{"menu": 0}, {"menu": 0}]])
    (run,) = trace["runs"]
    assert run["end"] == "submitted", run
    assert all("answers" not in step for step in run["steps"]), run
    (posted,) = run["steps"][-1]["submissions"]
    assert etree.fromstring(posted["instance"].encode()).findtext("{*}note") == "Automatic report", posted
    evidence("automatic-walk", run["steps"][-1])


@pytest.mark.parametrize(("command", "success"), [(2, True), (3, False)], ids=["changed-only", "full-check"])
def test_cross_answer_validation_is_rechecked_only_by_full_validation(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence, command, success,
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published, apps.served(
        published, formplayer_runner,
    ) as served, served.run("cross-answer"):
        web = apps.web(formplayer_runner, served)
        form = _form(web, command)
        fields = _answers(form)
        values = {fields["First note"]: "accepted", fields["Later decision"]: "deny"}
        for index, answer in values.items():
            assert web.answer(form["session_id"], index, answer)["status"] == "accepted"
        before = len(served.hq.submissions)
        outcome = web.submit(form["session_id"], values)
        received = served.hq.submissions[before:]
        evidence("cross-answer", {"outcome": outcome, "posted": len(received)})
        if success:
            assert outcome["status"] == "success", outcome
            instance, = received
            root = etree.fromstring(instance.instance)
            assert (root.findtext("{*}note"), root.findtext("{*}decision")) == ("accepted", "deny")
        else:
            assert outcome["status"] == "validation-error" and not received, outcome
            assert outcome["errors"] == {
                fields["First note"]: {"status": "validation-error", "type": "constraint"},
            }, outcome


@pytest.mark.parametrize(("note", "calculated"), [(None, "a!"), ("ab", "ab!")], ids=["unrelated", "dependency"])
def test_a_repeat_keeps_the_insertion_answer_and_recalculates_before_submission(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence, note, calculated,
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published, apps.served(
        published, formplayer_runner,
    ) as served, served.run("repeat-starting-value"):
        web = apps.web(formplayer_runner, served)
        form = _form(web, 4)
        button, = [item for item in questions(form["tree"])
                   if item.get("repeatable") == "true" and item.get("exists") == "false"]
        row = web.form_request("new-repeat", form["session_id"], ix=button["ix"])
        visible = {item.get("caption"): item for item in questions(row["tree"])}
        assert visible["Value at insertion"]["answer"] == "D", visible
        assert visible["Row note"]["answer"] == "a", visible
        entered = {visible["Other note"]["ix"]: "unrelated"}
        if note is not None:
            entered[visible["Row note"]["ix"]] = note
        for index, answer in entered.items():
            assert web.answer(form["session_id"], index, answer)["status"] == "accepted"
        # The browser's submit sends every widget's answer, including the
        # two defaults that the worker left alone.
        entered.setdefault(visible["Row note"]["ix"], "a")
        entered[visible["Value at insertion"]["ix"]] = "D"
        before = len(served.hq.submissions)
        response = web.submit(form["session_id"], entered)
        assert response["status"] == "success", response
        received, = served.hq.submissions[before:]
        root = etree.fromstring(received.instance)
        saved, = root.findall("{*}rows")
        result = (saved.findtext("{*}seen"), saved.findtext("{*}value"))
        assert result == ("D", calculated), received.instance
        evidence("repeat-starting-value", {"inserted": "D", "submitted": result})
