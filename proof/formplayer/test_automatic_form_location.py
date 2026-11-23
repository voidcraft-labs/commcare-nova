"""The worker's own point survives a Web Apps submission with empty automatic metadata."""

from dataclasses import replace

from lxml import etree

from proof.checks.test_hq_side import _created, _document, _landed
from proof.formplayer import hq as formplayer
from proof.formplayer.walk import Walk, load_answer_table
from proof.hq.check import hq_check
from proof.observe import casedata, publish


def test_web_apps_submits_the_answer_but_no_automatic_device_fix(hq, core_runner, formplayer_runner):
    document = _document("targeted-gps-question")
    export = document.exports["minimum"]
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        refusal, lookups = publish.update(unit, app_id, document.edit.exports["minimum"].update, "D-prime")
        assert _landed(refusal, lookups), (refusal, lookups)
        database = casedata.CaseDatabase(user_id=casedata.USER_ID, username=casedata.USERNAME, user_data=(), cases=())
        with formplayer.serve(unit, None, app_id, runner=formplayer_runner, database=database, label="automatic-location") as served:
            table = load_answer_table()
            table = {**table, "dataTypes": {**table["dataTypes"], "geopoint": ["1.5 2.5 0.0 4.0"]}}
            trace = replace(Walk.of(served, runner=formplayer_runner), answer_table=table).run()
            submitted = [sent for run in trace["runs"] for step in run["steps"] for sent in step.get("submissions", [])]
            assert submitted, trace
            for sent in submitted:
                root = etree.fromstring(sent["instance"].encode())
                [point] = root.xpath("./*[local-name()='place']")
                assert [float(part) for part in point.text.split()] == [1.5, 2.5, 0.0, 4.0]
                [location] = root.xpath("./*[local-name()='meta']/*[local-name()='location']")
                assert location.text is None
