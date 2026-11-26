"""An ordinary form's independent setting reaches the Android sensor on local and published builds."""

import pytest

from proof.android import observe
from proof.checks.test_hq_side import _created, _document, _landed
from proof.formplayer import hq as formplayer
from proof.hq.check import hq_check
from proof.observe import casedata, publish
from proof.observe.record import Blobs
from proof.observe.served import local_archive

pytestmark = pytest.mark.reader("android")


def test_form_location_captures_a_fix_distinct_from_the_point_question(hq, core_runner, lane_services):
    document = _document("targeted-gps-question")
    export = document.exports["minimum"]
    assert document.edit is not None and document.local_ccz and document.edit.local_ccz
    with hq_check(export.configuration.hq()) as (unit, _):
        app_id = _created(unit, export)
        refusal, lookups = publish.update(unit, app_id, document.edit.exports["minimum"].update, "D-prime")
        assert _landed(refusal, lookups), (refusal, lookups)
        database = casedata.CaseDatabase(user_id=casedata.USER_ID, username=casedata.USERNAME, user_data=(), cases=())
        with formplayer.serve(unit, None, app_id, database=database, label="automatic-location") as served:
            blobs = Blobs()
            # The question’s independently authored answer is 1.5 2.5 0.0 4.0.
            fix = [12.5, -73.25, 940.0, 3.0]
            for label, archive, expected in (
                ("question-only", local_archive(document.local_ccz, app_id), None),
                ("form-location", local_archive(document.edit.local_ccz, app_id), "12.5 -73.25 940.0 3.0"),
                ("published-form-location", observe.release_archive(served), "12.5 -73.25 940.0 3.0"),
            ):
                record = observe.automatic_location(served, blobs, archive, fix, label)
                answer = blobs.get_json(record["answer"])
                assert (answer["install"], answer["loaded"]) == ("Installed", True), answer
                assert answer["beforeFix"] is None, answer
                assert [sample["node"] for sample in answer["fixes"]] == [expected], answer
