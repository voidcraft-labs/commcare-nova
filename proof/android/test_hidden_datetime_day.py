"""The Android worker submits both the hidden timestamp and its date-only case leaf."""

import pytest

from proof.android import observe
from proof.editors.test_hidden_datetime_day import CLOCK, assert_hidden_day_payload, hidden_day_database, prepare_hidden_day
from proof.formplayer import hq as formplayer
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")


def test_android_preserves_the_hidden_stamp_and_writes_its_day(hq):
    with hq_check(Configuration()) as (state, _):
        app_id, _ = prepare_hidden_day(state)
        with formplayer.serve(state, None, app_id, database=hidden_day_database(), label="hidden-day") as served:
            archive = observe.release_archive(served)
            blobs, sent = Blobs(), []
            result = observe.app(
                served, blobs, label="hidden-day", archive=archive, sent=sent,
                commands=["m0-f0"], questions={"/data/note": ["A visit"]}, clock=CLOCK,
            )
            assert len(sent) == 1, blobs.get_json(result["answer"])
            assert_hidden_day_payload(sent[0])
