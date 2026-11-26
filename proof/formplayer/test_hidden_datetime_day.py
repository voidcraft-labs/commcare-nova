"""The worker submits both the hidden timestamp and its date-only case leaf."""

from dataclasses import replace

from proof.editors.test_hidden_datetime_day import CLOCK, assert_hidden_day_payload, hidden_day_database, prepare_hidden_day
from proof.formplayer import hq as formplayer
from proof.formplayer.walk import Walk
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration


def test_formplayer_preserves_the_hidden_stamp_and_writes_its_day(hq, formplayer_runner):
    with hq_check(Configuration(privileges={"CLOUDCARE"})) as (state, _):
        app_id, xmlns = prepare_hidden_day(state)
        with formplayer.serve(
            state, None, app_id, runner=formplayer_runner, database=hidden_day_database(), label="hidden-day",
        ) as served:
            trace = replace(Walk.of(served, runner=formplayer_runner), clock=CLOCK).run()
            submissions = [
                sent["instance"].encode()
                for run in trace["runs"]
                for step in run["steps"]
                for sent in (step.get("submissions") or ())
                if xmlns in sent["instance"]
            ]
            assert submissions, trace
            for submission in submissions:
                assert_hidden_day_payload(submission)
