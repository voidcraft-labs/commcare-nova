"""A cross-type case itemset authored in Vellum filters the worker's restored records."""

from lxml import etree

from proof.editors.conftest import corpus_document, write_evidence
from proof.formplayer import apps, hq as formplayer
from proof.formplayer.test_lookup_tags import _opened, _questions
from proof.formplayer.walk import screen_kind
from proof.hq.check import hq_check
from proof.matrix.authoring import Authoring
from proof.matrix.variants import questions
from proof.observe import casedata, publish

QUERY = "instance('casedb')/casedb/case[survey_ready = 'yes']"


def _case(case_id, case_type, label, ready, owner_id=casedata.USER_ID):
    stamp = "2025-12-01T08:00:00.000Z"
    return casedata.CaseRecord(
        case_id, case_type, label, owner_id, stamp, stamp, None, (("survey_ready", ready),),
    )


def _database():
    return casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (), (
        _case("ready-clinic", "clinic", "North clinic", "yes"),
        _case("waiting-clinic", "clinic", "Riverside clinic", "no"),
        _case("ready-outpost", "outpost", "Hill outpost", "yes"),
        _case("private-outpost", "outpost", "Private outpost", "yes", owner_id="another-worker"),
    ))


def _worker(unit, app_id, document, runner, label, *, select=None):
    with formplayer.serve(unit, document, app_id, runner=runner, label=label,
                          database=_database()) as served, served.run(label):
        web = apps.web(runner, served)
        screen = _opened(web)
        assert screen_kind(screen) == "form", screen
        district, = [q for q in _questions(screen["tree"]) if q.get("binding") == "/data/district"]
        result = {"choices": district["choices"]}
        if select is not None:
            index = district["choices"].index(select) + 1
            start = len(served.hq.submissions)
            reply = web.submit(screen["session_id"], {district["ix"]: index})
            assert reply.get("status") == "success", reply
            submission, = served.hq.submissions[start:]
            result["submitted"] = etree.fromstring(submission.instance).findtext("{*}district")
        return result


def test_vellum_filters_available_cases_by_survey_readiness(hq, editor_driver, formplayer_runner):
    document = corpus_document("hq-lookups")
    with hq_check(document.exports["minimum"].configuration.hq()) as (unit, _):
        with unit.operation("case-itemset:source", b"hq-lookups"):
            app_id, refusal, _ = publish.create_authored(unit, document)
            assert refusal is None
        authoring = Authoring(unit, {}, base=document.id, driver=editor_driver, operation=unit.operation)
        with unit.fork():
            questions.itemset_over_cases(authoring, app_id)
            unfiltered = _worker(unit, app_id, document, formplayer_runner, "unfiltered-survey-cases")

        run = questions.itemset_filters_available_cases_by_survey_readiness(authoring, app_id)
        root = etree.fromstring(run.stored_source.encode())
        itemset, = root.xpath("//*[local-name()='select1' and @ref='/data/district']/*[local-name()='itemset']")
        source = {
            "nodeset": itemset.get("nodeset"),
            "label": itemset.xpath("./*[local-name()='label']/@ref"),
            "value": itemset.xpath("./*[local-name()='value']/@ref"),
            "instance": root.xpath("//*[local-name()='instance' and @id='casedb']/@src"),
        }
        assert source == {
            "nodeset": QUERY, "label": ["case_name"], "value": ["@case_id"], "instance": ["jr://instance/casedb"],
        }
        filtered = _worker(
            unit, app_id, document, formplayer_runner, "survey-ready-cases", select="Hill outpost",
        )

    write_evidence("case-itemset-survey-readiness", {"source": source, "unfiltered": unfiltered, "filtered": filtered})
    assert sorted(unfiltered["choices"]) == ["Hill outpost", "North clinic", "Riverside clinic"]
    assert sorted(filtered["choices"]) == ["Hill outpost", "North clinic"]
    assert filtered["submitted"] == "ready-outpost"
