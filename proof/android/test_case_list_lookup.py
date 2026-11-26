"""The installed case-list lookup receives a companion's Android activity result."""

from __future__ import annotations

from dataclasses import replace

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


def _view_texts(value):
    if isinstance(value, list):
        return [text for child in value for text in _view_texts(child)]
    if not isinstance(value, dict) or value.get("visibility") in ("gone", "invisible"):
        return []
    return ([value["text"]] if value.get("text") else []) + _view_texts(value.get("children", []))


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
        {"identify": "lookup-juniper", "inspectScores": True},
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
    assert "Match" in _view_texts(identity["scoreHeader"])
    assert _view_texts(identity["scoreRows"]) == ["Juniper", "★★★★★"]
    assert unknown_identity["isIdentification"] and unknown_identity["after"] == []



@pytest.mark.parametrize("extra", ["scan", "'scan'"], ids=["relative", "text"])
def test_case_list_lookup_evaluates_extras_before_a_case_is_selected(hq, editor_driver, extra):
    database = casedata.CaseDatabase(
        user_id=casedata.USER_ID,
        username=casedata.USERNAME,
        user_data=(),
        cases=(
            replace(_case("lookup-cedar", "Cedar"), properties=(("scan", "first record"),)),
            replace(_case("lookup-juniper", "Juniper"), properties=(("scan", "second record"),)),
        ),
    )
    with hq_check(CONFIGURATION) as (state, _):
        app_id, _ = _lookup_case_list(state, editor_driver, extras=[{"key": "mode", "value": extra}])
        with formplayer.serve(state, None, app_id, database=database, label="case-list-lookup") as served:
            blobs = Blobs()
            record = observe.app(
                served,
                blobs,
                label="case-list-lookup-extra",
                archive=observe.release_archive(served),
                case_lookup_returns=[{"primary": "  Juniper  "}],
            )
            installed = blobs.get_json(record["answer"])

    write_evidence("android-case-list-lookup-extra", installed)
    assert installed["install"] == "Installed", installed
    assert installed["signIn"].startswith("Success("), installed
    walks = installed["walks"].values()
    if extra == "scan":
        (failure,) = [walk["raised"] for walk in walks if "raised" in walk]
        assert "Cannot evaluate the reference [/scan]" in failure["stack"], failure
        assert "No default instance has been declared!" in failure["stack"], failure
        assert "EntitySelectCalloutSetup.buildCalloutIntent" in failure["stack"], failure
        assert "EntitySelectActivity.setUpCalloutClickListener" in failure["stack"], failure
        assert not any(
            "lookupReturns" in (step.get("list") or {})
            for walk in walks for step in walk.get("steps", [])
        ), installed["walks"]
    else:
        assert not any("raised" in walk for walk in walks), installed["walks"]
        (observed,) = [
            step["list"]["lookupReturns"]
            for walk in walks for step in walk.get("steps", [])
            if "lookupReturns" in (step.get("list") or {})
        ]
        (reply,) = observed
        assert set(reply["before"]) == {"Cedar", "Juniper"}
        assert reply["action"] == ACTION and reply["sent"] == {"mode": "scan"}
        assert (reply["searchText"], reply["after"]) == ("Juniper", ["Juniper"])


def test_nova_archive_and_hq_release_send_extras_and_search_text(hq, android_documents):
    from proof.android.test_form_reads import _served
    from proof.observe.served import local_archive

    document = android_documents["targeted-case-list-device-lookup"]
    database = casedata.CaseDatabase(
        user_id=casedata.USER_ID,
        username=casedata.USERNAME,
        user_data=(),
        cases=(_case("lookup-cedar", "Cedar"), _case("lookup-juniper", "Juniper")),
    )
    commands = [
        {"automatic": True, "primary": " Cedar ", "inspectIcon": True},
        {"primary": None, "named": {"first": "Juniper", "second": "Cedar"}},
        {"primary": "none-matches"},
        {"identify": "lookup-juniper", "inspectScores": True},
    ]
    with _served(document, database=database) as (served, released):
        blobs = Blobs()
        assert document.local_ccz is not None
        local = local_archive(document.local_ccz, served.app_id)
        for label, archive in (("hq", released), ("local", local)):
            answer = observe.app(served, blobs, label=label, archive=archive, case_lookup_returns=commands)
            installed = blobs.get_json(answer["answer"])
            write_evidence(f"nova-case-list-lookup-{label}-walk", installed)
            assert installed["install"] == "Installed", installed
            observations = [
                step["list"]["lookupReturns"]
                for walk in installed["walks"].values()
                for step in walk.get("steps", [])
                if isinstance(step.get("list"), dict) and "lookupReturns" in step["list"]
            ]
            assert len(observations) == 1, (label, blobs.get_json(answer["hq"]), installed["walks"].keys())
            (results,) = observations
            assert results[0]["iconCenterARGB"] == "ff49a274"  # The uploaded PNG’s one pixel.
            assert results[0]["lookupName"] == "Find a visit"
            assert results[0]["toolbarTitle"] == "Scan Barcode"
            assert [result["after"] for result in results] == [["Cedar"], ["Juniper"], [], ["Juniper"]]
            assert [result["searchText"] for result in results[:3]] == ["Cedar", "Juniper", "none-matches"]
            assert results[3]["isIdentification"]
            assert "Confidence" in _view_texts(results[3]["scoreHeader"])
            assert _view_texts(results[3]["scoreRows"]) == ["Juniper", "★★★★★"]
            assert all(result["action"] == ACTION for result in results)
            assert all(result["sent"] == {
                "visit_mode": "followup", "visit_limit": "3",
                "worker_name": database.username, "worker_id": database.user_id,
            } for result in results)
            write_evidence(f"nova-case-list-lookup-{label}", results)


def test_lookup_count_comes_from_the_selected_native_frame(hq, android_documents):
    """A completed form receives the selection step's unique response keys, including keys absent from restore."""
    from lxml import etree

    from proof.android.test_form_reads import _app, _child, _completed_walk, _served
    from proof.observe.served import local_archive

    document = android_documents["targeted-case-list-device-lookup-count"]
    database = casedata.CaseDatabase(
        user_id=casedata.USER_ID,
        username=casedata.USERNAME,
        user_data=(),
        cases=(_case("lookup-cedar", "Cedar"), _case("lookup-juniper", "Juniper")),
    )
    controls = [
        ("ordinary", [], "lookup-cedar", None),
        ("missing-handler", [{"missingHandler": True}], "lookup-cedar", None),
        ("cancelled", [{"primary": "Juniper", "cancel": True}], "lookup-cedar", None),
        ("text-only", [{"primary": "Cedar"}], "lookup-cedar", None),
        ("empty-identification", [{"identifyKeys": []}, {"primary": "Cedar"}], "lookup-cedar", "0"),
        ("one-key", [{"identifyKeys": ["lookup-juniper"]}], "lookup-juniper", "1"),
        ("one-match-two-keys", [{"identifyKeys": ["lookup-juniper", "outside", "lookup-juniper"]}],
         "lookup-juniper", "2"),
    ]
    with _served(document, database=database) as (served, released):
        assert document.local_ccz is not None
        local = local_archive(document.local_ccz, served.app_id)
        for carrier, archive in (("hq", released), ("local", local)):
            seen = {}
            for label, commands, chosen, count in controls:
                answer, sent = _app(
                    served, archive, f"{carrier}-{label}", commands=["m0-f0"],
                    case_lookup_returns=commands, questions={"/data/note": "checked"},
                )
                assert answer["install"] == "Installed", answer
                _completed_walk(answer, "m0-f0")
                (instance,) = sent
                root = etree.fromstring(instance, etree.XMLParser(resolve_entities=False, no_network=True))
                native_list, = [step["list"] for step in answer["walks"]["m0-f0"]["steps"] if "lookupReturns" in step.get("list", {})]
                assert native_list["chose"] == chosen, (carrier, label, native_list)
                value = _child(root, "lookup_count").text
                assert value == count, (carrier, label, value, native_list)
                seen[label] = {"chosen": chosen, "count": value, "results": native_list["lookupReturns"]}
            write_evidence(f"native-companion-lookup-count-{carrier}", seen)
