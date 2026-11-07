"""A worker's user case starts at the input date, even with HQ's determinism disabled.

HQ creates that case during its own worker save. Giving separate app states different setup dates made
unchanged cases compare differently on Android. Later saves must still advance the date: freezing the whole
served state, or discarding the date from records, would conceal behavior this comparison needs to see.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
import time_machine

from proof.formplayer.hq import create_worker, default_roles
from proof.hq import determinism
from proof.hq import redis as hq_redis
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe import casedata


@pytest.mark.parametrize("stamp", ["2025-12-01T08:00:00.000Z", "2026-02-03T09:10:11.000Z", None])
def test_worker_setup_uses_the_input_date_and_later_saves_use_the_callers_clock(hq, monkeypatch, stamp):
    monkeypatch.setattr(determinism, "ENABLED", False)
    cases = (
        ()
        if stamp is None
        else (
            casedata.CaseRecord(
                case_id=casedata.USERCASE_ID,
                case_type=casedata.USERCASE_TYPE,
                name=casedata.USERNAME,
                owner_id=casedata.USER_ID,
                opened_on=stamp,
                modified_on=stamp,
                external_id=None,
                properties=(),
            ),
        )
    )
    database = casedata.CaseDatabase(casedata.USER_ID, casedata.USERNAME, (("session_note", "before"),), cases)
    outside = datetime(2035, 4, 5, 6, 7, 8, tzinfo=UTC)
    later = datetime(2035, 4, 6, 7, 8, 9, tzinfo=UTC)
    with (
        hq_check(Configuration(privileges={"USERCASE"})) as (unit, _),
        hq_redis.shared(None),
        unit.committing(),
        time_machine.travel(outside, tick=False),
    ):
        default_roles(unit)
        worker = create_worker(unit, database)
        case = worker.get_usercase()
        assert case is not None
        expected = casedata._datetime(stamp) if stamp else outside.replace(tzinfo=None)
        assert case.modified_on == expected
        assert case.get_case_property("session_note") == "before"
        assert datetime.now(UTC) == outside

        # This is HQ's subsequent user save, not the setup helper: its change and timestamp remain visible.
        with time_machine.travel(later, tick=False):
            worker.first_name = "Changed"
            worker.save()
        changed = worker.get_usercase()
        assert changed.get_case_property("first_name") == "Changed"
        assert changed.modified_on == later.replace(tzinfo=None)
        assert datetime.now(UTC) == outside
