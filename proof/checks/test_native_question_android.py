"""A device's reviewed split, an edited sibling, a wrong widget, and an unrelated path change."""

from copy import deepcopy

import pytest

from proof.checks import android, android_places, native_question_android
from proof.checks.native_question_split import FormSplit, Split

POSITION = "2.1"
BASE = "/data/members[2]/"
ORIGINAL, DATE, TIME = [BASE + name + "[1]" for name in ("visit", "day", "hour")]
SPLITS = {
    POSITION: FormSplit("urn:a", "urn:b", (Split("/data/members/visit", "/data/members/day", "/data/members/hour"),))
}
PATH = "/walks/*/steps/*/form/path"
WALK = "m2/m2-f1"


def question(reference, widget, given, shown, label="Visit"):
    prompt = {"reference": reference, "text": label, "widget": widget, "required": False}
    return {
        "event": "QUESTION",
        "index": reference,
        "alert": None,
        "questions": [dict(prompt, answer=None)],
        "answered": [{"given": given, "reference": reference}],
        "shown": [dict(prompt, answer=shown)],
    }


def record(*screens):
    form = {"loaded": True, "language": "en", "screens": list(screens)}
    step = {"screen": "FormEntryActivity", "session": {"command": "m2-f1"}, "form": form}
    return {"install": "Installed", "walks": {WALK: {"steps": [step]}}}


def devices():
    joined = question(ORIGINAL, "DateTimeWidget", "2026-01-15T10:30:00.000Z", "15/01/26 10:30")
    date = question(DATE, "DateWidget", "2026-01-15", "15/01/26")
    time = question(TIME, "TimeWidget", "14:30:00", "14:30")
    notes = [question(BASE + name + "[1]", "StringWidget", "ok", "ok", name) for name in ("name", "note")]
    return record(joined, *notes), record(date, time, *deepcopy(notes))


def compare(a, b, splits=SPLITS):
    return android.app_differences(a, b, check="proof3", document="review", artifact=android.REPUBLISH, splits=splits)


def step(record):
    return record["walks"][WALK]["steps"][0]


def test_split_keeps_the_device_receipts_and_places_them_on_the_opened_form():
    a, b = devices()
    original_inputs = deepcopy((a, b))
    (row,) = compare(a, b)
    assert row.path == native_question_android.PLACE_PATH
    assert row.at.endswith("/form/dateTimeSplit/~1data~1members[2]~1visit[1]")
    assert row.before == step(a)["form"]["screens"][0]
    assert row.after == step(b)["form"]["screens"][:2]
    for device, before in [(a, True), (b, False)]:
        assert android_places.locations([row], device, before=before)[row.artifact, row.at] == (
            "form",
            POSITION,
            "xform",
            "data",
            "members",
            "visit",
        )
    assert (a, b) == original_inputs
    step(b)["form"]["screens"][0]["shown"][0]["text"] = "Changed"
    assert android_places.locations([row], b)[row.artifact, row.at] is None


def test_concurrent_sibling_edit_and_reorder_still_show_beyond_the_two_widgets():
    a, b = devices()
    screens = step(b)["form"]["screens"]
    screens[2], screens[3] = screens[3], screens[2]
    screens[3]["shown"][0]["text"] = "Changed"
    differences = {d.path: d for d in compare(a, b)}
    caption = "/walks/*/steps/*/form/screens/*/shown/*/text"
    assert set(differences) == {PATH, native_question_android.PLACE_PATH, caption}
    assert differences[PATH].before.endswith("name[1] | QUESTION " + BASE + "note[1]")
    assert differences[PATH].after.endswith("note[1] | QUESTION " + BASE + "name[1]")
    changed = differences[caption]
    assert (changed.before, changed.after) == ("name", "Changed")
    for device, before in [(a, True), (b, False)]:
        assert android_places.locations([changed], device, before=before)[changed.artifact, changed.at] == (
            "form",
            POSITION,
            "xform",
            "data",
            "members",
            "name",
            ":itext",
            "label",
            "en",
            "default",
        )


@pytest.mark.parametrize(
    ("field", "key", "value"),
    [
        ("questions", "widget", "StringWidget"),
        ("shown", "answer", "14:31"),
        ("answered", "given", "14:31:00"),
        ("shown", "text", "Other"),
        ("shown", "required", True),
        ("answered", "reference", "/data/members[1]/hour[1]"),
        ("answered", "refused", ["14:30:00: constraint"]),
    ],
)
def test_a_wrong_widget_answer_or_prompt_is_an_unregistered_path(field, key, value):
    a, b = devices()
    step(b)["form"]["screens"][1][field][0][key] = value
    assert [d.path for d in compare(a, b)] == [PATH]


def test_both_session_commands_the_review_and_the_adjacent_control_order_are_required():
    a, b = devices()
    assert [d.path for d in compare(a, b, {})] == [PATH]
    for device in (a, b):
        step(device)["session"]["command"] = "m1-f1"
    assert [d.path for d in compare(a, b)] == [PATH]
    a, b = devices()
    screens = step(b)["form"]["screens"]
    screens[0], screens[1] = screens[1], screens[0]
    assert [d.path for d in compare(a, b)] == [PATH]
    a, b = devices()
    step(b)["form"]["screens"].append(deepcopy(step(b)["form"]["screens"][0]))
    assert [d.path for d in compare(a, b)] == [PATH]
