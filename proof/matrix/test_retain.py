"""What ``proof/matrix/retain.py`` makes of the reader bundle's answer, with no HQ: the entries it counts, and why a
base it did not read is not retained.

The contract: ``claimed`` reads the entry ids of an answer's claims under
both of the bundle's spellings (the JSON of counts by entry, and the claim
log a line a claim), counts nothing of an empty log, and refuses an answer
that holds no claims at all; and ``not_read_message`` names each finding's
code, standing, place and the key or path it names, once for each distinct
finding, bounded however many there are. The plausible failures: a bundle
answer that drops its claims read as a base claiming nothing, which wrote
``"claimed": []`` for every base a run read; and a refusal that names an
``unrecognized`` finding without the key it found, so its cause cannot be
studied without another run. ``holds`` judges a set-json row's value served
where HQ's source read holds what the row set: a logo slot HQ's source read
decorates with keys of its own holds the path a row set, and a key dropped, an
item missing or another value does not.
"""

from __future__ import annotations

import json

import pytest

from proof.matrix import retain


def test_counts_name_each_entry_counted_at_least_once_in_order():
    answer = {"id": "hq-questions", "kind": "read", "claims": json.dumps({"q/b": 2, "q/a": 1, "q/zero": 0})}
    assert retain.claimed(answer) == ["q/a", "q/b"]


def test_a_full_log_names_each_claim_s_entry_once():
    lines = [
        {"artifact": "app", "where": "", "key": "name", "entry": "s/name", "standing": "allowing"},
        {"artifact": "app", "where": "", "key": "langs", "entry": "s/langs", "standing": "allowing"},
        {"artifact": "app", "where": "", "key": "name", "entry": "s/name", "standing": "allowing"},
        {"artifact": "app", "where": "", "key": "other", "entry": None, "standing": "allowing"},
    ]
    answer = {"id": "hq-plain", "kind": "read", "claims": "\n".join(json.dumps(line) for line in lines) + "\n"}
    assert retain.claimed(answer) == ["s/langs", "s/name"]


def test_an_empty_log_counts_nothing():
    assert retain.claimed({"id": "hq-plain", "kind": "account", "claims": ""}) == []


def test_an_answer_that_holds_no_claims_is_refused_by_name():
    answer = {"id": "hq-questions", "kind": "read", "declaration": {}, "firstPublish": [], "asked": []}
    with pytest.raises(AssertionError, match=r"answer for hq-questions \(read\) holds no claims"):
        retain.claimed(answer)


def _finding(code, place, name=None):
    finding = {"code": code, "standing": "not-yet", "place": place, "subject": None, "detail": {}}
    if name is not None:
        finding["detail"]["name"] = name
    return finding


def test_a_not_read_message_names_each_finding_s_key_once_with_how_often_it_was_found():
    remark = {"kind": "question", "menu": 0, "form": 1, "menuName": "Households", "formName": "Followup", "path": "x"}
    answer = {
        "id": "hq-plain",
        "kind": "account",
        "findings": [
            _finding("unrecognized", remark, "vellum:hint"),
            _finding("unrecognized", remark, "vellum:hint"),
            _finding("menus/detail-pull-down-tile", {"kind": "case-list", "menu": 0, "name": "Case List"}),
        ],
    }
    message = retain.not_read_message("hq-plain", answer, "/out/hq-apps-unread/hq-plain")
    assert "unrecognized (not-yet) at " in message
    assert '"path": "x"' in message
    assert "naming 'vellum:hint' (2 times)" in message
    assert message.count("vellum:hint") == 1
    assert "menus/detail-pull-down-tile (not-yet) at " in message
    assert message.endswith("HQ's answers and the whole reading are under /out/hq-apps-unread/hq-plain.")


def test_a_not_read_message_is_bounded_however_many_findings_and_however_long_a_name():
    findings = [_finding("unrecognized", {"kind": "app"}, f"key-{n}-" + "y" * 500) for n in range(40)]
    message = retain.not_read_message("hq-search", {"id": "hq-search", "kind": "account", "findings": findings}, "/o")
    assert f"; and {40 - retain.LISTED_FINDINGS} more." in message
    assert "key-0-" in message and f"key-{retain.LISTED_FINDINGS}-" not in message
    assert "y" * retain.NAME_SHOWN not in message
    assert len(message) < retain.LISTED_FINDINGS * (retain.NAME_SHOWN + 80) + 600


def test_an_object_holds_what_the_row_set_beside_the_keys_hq_adds():
    path = "jr://file/commcare/logo/data/hq_logo_android_home.png"
    served = {"path": path, "url": "/hq/multimedia/file/CommCareImage/m1/", "icon_class": "fa-regular fa-image"}
    assert retain.holds(served, {"path": path})
    assert not retain.holds(served, {"path": path, "m_id": "m1"})
    assert not retain.holds({"path": "jr://file/other.png"}, {"path": path})


def test_a_list_holds_each_item_in_its_place_and_a_value_is_itself():
    assert retain.holds([{"test": "true()", "doc_type": "CustomAssertion"}], [{"test": "true()"}])
    assert not retain.holds(["en"], ["en", "fra"])
    assert not retain.holds(["fra", "en"], ["en", "fra"])
    assert retain.holds("yes", "yes")
    assert not retain.holds(retain._MISSING, None)
    assert not retain.holds(None, {"path": "p"})
