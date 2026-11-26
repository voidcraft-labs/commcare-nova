"""The installed case-list lookup receives a companion's Android activity result."""

from __future__ import annotations

import pytest

from proof.android import observe
from proof.editors.conftest import write_evidence
from proof.editors.test_case_list_lookup_page import ACTION, _lookup_case_list
from proof.formplayer import hq as formplayer
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.observe import casedata
from proof.observe.record import Blobs

pytestmark = pytest.mark.reader("android")

CONFIGURATION = Configuration(privileges={"CLOUDCARE"}, flags={"CASE_LIST_LOOKUP"})


def _case(key, name):
    return casedata.CaseRecord(
        case_id=key,
        case_type="visit",
        name=name,
        owner_id=casedata.USER_ID,
        opened_on="2025-12-01T08:00:00.000000Z",
        modified_on="2025-12-01T08:00:00.000000Z",
        external_id=None,
        properties=(),
        indices=(),
    )


def test_case_list_lookup_reads_the_companions_native_result(hq, editor_driver):
    """HQ's Case List save sets up the action; only Android's own result branches may filter the list."""
    database = casedata.CaseDatabase(
        user_id=casedata.USER_ID,
        username=casedata.USERNAME,
        user_data=(),
        cases=(_case("lookup-cedar", "Cedar"), _case("lookup-juniper", "Juniper")),
    )
    commands = [
        {"missingHandler": True},
        {"primary": "  Cedar  "},
        {"primary": "Juniper", "cancel": True},
        {"named": {"first": "Juniper"}},
        {"primary": None, "named": {"second": "Cedar", "first": "Juniper"}},
        {"primary": None, "named": {"first": None, "second": "Cedar"}},
        {"primary": "unmatchable"},
        {"identify": "lookup-juniper"},
        {"identify": "not-in-restore"},
    ]
    with hq_check(CONFIGURATION) as (state, _):
        app_id, _ = _lookup_case_list(state, editor_driver)
        with formplayer.serve(state, None, app_id, database=database, label="case-list-lookup") as served:
            blobs = Blobs()
            record = observe.app(
                served,
                blobs,
                label="case-list-lookup",
                archive=observe.release_archive(served),
                case_lookup_returns=commands,
            )
            installed = blobs.get_json(record["answer"])

    assert installed["install"] == "Installed", installed
    (observed,) = [
        step["list"]["lookupReturns"]
        for walk in installed["walks"].values()
        for step in walk.get("steps", [])
        if isinstance(step.get("list"), dict) and "lookupReturns" in step["list"]
    ]
    write_evidence("android-case-list-lookup", observed)
    missing, text, canceled, no_marker, named, fallback, no_match, identity, unknown_identity = observed
    assert sorted(missing["before"]) == sorted(missing["after"]) == ["Cedar", "Juniper"]
    assert ACTION in missing["toast"]
    for sample in observed[1:]:
        assert sample["action"] == ACTION
        assert sample["sent"] == {"visit_mode": "followup", "visit_limit": "3"}
    assert (text["after"], text["searchText"]) == (["Cedar"], "Cedar")
    assert (canceled["after"], canceled["searchText"]) == (["Cedar"], "Cedar")
    assert no_marker["toast"] and (no_marker["after"], no_marker["searchText"]) == (["Cedar"], "Cedar")
    assert (named["after"], named["searchText"]) == (["Juniper"], "Juniper")
    assert (fallback["after"], fallback["searchText"]) == (["Cedar"], "Cedar")
    assert (no_match["after"], no_match["searchText"]) == ([], "unmatchable")
    assert all(not reply["isIdentification"] for reply in observed[:7])
    assert identity["isIdentification"] and identity["after"] == ["Juniper"]
    assert unknown_identity["isIdentification"] and unknown_identity["after"] == []
