"""The worker completes a visit in each HQ-authored directory and in Nova's republish."""
from hashlib import sha256

import pytest
from lxml import etree

from proof.formplayer import apps
from proof.formplayer.hq import serve
from proof.formplayer.walk import questions, screen_kind
from proof.hq.check import hq_check
from proof.observe import casedata, publish


def visit_cases():
    stamp = "2025-12-01T08:00:00.000Z"

    def visit(key, name, area, priority):
        return casedata.CaseRecord(key, "visit", name, "another-worker", stamp, stamp, None, (("district", area), ("priority", priority)))

    return casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        visit("eligible-north", "North clinic", "north", "10"),
        visit("other-area", "South clinic", "south", "10"),
        visit("later-north", "Follow up later", "north", "2"),
    ))


@pytest.mark.parametrize(("directory", "source_field", "expected"), [
    ("hq-project-search", "district", ["eligible-north", "later-north"]),
    ("hq-project-database-search", "area", ["eligible-north"]),
], ids=["elasticsearch", "projectdb"])
@pytest.mark.parametrize("state", ["authored", "republished"])
def test_worker_completes_the_visit_selected_from_the_published_directory(
    state, directory, source_field, expected, hq, formplayer_runner, formplayer_documents, evidence,
):
    from corehq.apps.case_search.models import CaseSearchEndpoint
    from corehq.form_processor.models import CommCareCase

    doc = formplayer_documents[directory]
    sql = directory == "hq-project-database-search"
    export = doc.exports["minimum"]
    with hq_check(export.configuration.hq()) as (unit, _):
        with unit.operation("remake HQ's visit directory and its active service", sha256(doc.id.encode()).digest()):
            app_id, refusal, _ = publish.create_authored(unit, doc)
            assert refusal is None
        if state == "republished":
            with unit.operation("republish the visit directory", sha256(export.republish.body_path.read_bytes()).digest()):
                refusal, _ = publish.update(unit, app_id, export.republish, "B")
                assert refusal is None, refusal
        with serve(unit, doc, app_id, runner=formplayer_runner, database=visit_cases()) as served, served.run(state):
            served.hq.capture_search_fixtures = True
            client = apps.web(formplayer_runner, served)
            screen = client.navigate(["0"])
            assert screen_kind(screen) == "entities", screen
            assert sorted(e["id"] for e in screen["entities"]) == expected, screen
            [request] = [r for r in served.hq.searches if r.values("area") == ("north",)]
            assert request.values("minimum_priority") == (("3",) if sql else ()), request.params
            service = CaseSearchEndpoint.objects.get(domain=unit.domain, is_active=True)
            assert request.values("x_commcare_endpoint_id") == (str(service.pk),)
            result = etree.fromstring(request.fixture)
            assert sorted((case.get("case_id"), case.findtext(source_field)) for case in result.xpath(".//case[@case_id]")) == [
                (case_id, "north") for case_id in expected
            ], request.fixture
            next_screen = client.navigate([*screen["selections"], "eligible-north"])
            if screen_kind(next_screen) == "entities":
                assert "eligible-north" in [e["id"] for e in next_screen["entities"]], next_screen
                next_screen = client.navigate([*next_screen["selections"], "eligible-north"])
            if screen_kind(next_screen) == "commands":
                assert len(next_screen["commands"]) == 1, next_screen
                next_screen = client.navigate([*next_screen["selections"], "0"])
            assert screen_kind(next_screen) == "form", next_screen
            assert [r.values("case_id") for r in served.hq.claims] == [("eligible-north",)]
            fields = {q["datatype"]: q for q in questions(next_screen["tree"])}
            select = fields["select"]
            assert select["choices"] == ["North", "South"], select
            answers = {select["ix"]: "2", fields["str"]["ix"]: "Visit complete"}
            if sql:
                answers[fields["int"]["ix"]] = "1"
            before_submit = len(served.hq.submissions)
            client.submit(next_screen["session_id"], answers)
            sent = [etree.fromstring(s.instance) for s in served.hq.submissions[before_submit:] if s.instance]
            changes = [(block.get("case_id"), block.xpath("string(./*[local-name()='update']/*[local-name()='district'])"),
                        block.xpath("string(./*[local-name()='update']/*[local-name()='priority'])"))
                       for instance in sent for block in instance.xpath("//*[local-name()='case'][@case_id]")]
            assert changes == [("eligible-north", "south", "1" if sql else "")], changes
            saved = {key: CommCareCase.objects.get_case(key, domain=unit.domain).case_json
                     for key in ("eligible-north", "later-north", "other-area")}
            assert (saved["eligible-north"]["district"], saved["eligible-north"]["priority"]) == (
                "south", "1" if sql else "10"
            ), saved
            assert (saved["later-north"]["district"], saved["other-area"]["district"]) == ("north", "south")
            assert not served.hq.failures(), served.hq.failures()
            evidence(state, {"request": request.params, "returned": request.fixture.decode("utf-8"),
                             "selected": [e["id"] for e in screen["entities"]],
                             "claims": [r.params for r in served.hq.claims], "updates": changes, "saved": saved})
