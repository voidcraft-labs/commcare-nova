from copy import deepcopy

import pytest

from proof.checks.compare.json_tree import compare_json
from proof.checks.native_question_split import FormSplit, Split
from proof.checks.native_question_web import align_screens

Q = Split("/data/visit", "/data/day", "/data/hour")
R = Split("/data/second", "/data/second_day", "/data/second_hour")
SPLITS = {"1.2": FormSplit("urn:a", "urn:b", (Q,))}
SCRIPT = [{"menu": 1}, {"menu": 2}]


def observations(side, preview=False, layout=("start", Q, "note")):
    fields = []
    for item in layout:
        if isinstance(item, Split):
            if side == "a":
                fields.append((item.original, "datetime", "Visit", None))
            else:
                fields.extend([(item.date, "date", "Visit", "2026-01-15"), (item.time, "time", "Visit", "14:30")])
        elif item == "start":
            fields.append(("/data/start", "info", "Start", None))
        else:
            fields.append(("/data/note", "str", "Notes", "some text"))

    def tree(filled):
        return [
            {
                "type": "question",
                "ix": str(i),
                "binding": path,
                "question_id": path.rsplit("/", 1)[1],
                "caption": label,
                "datatype": kind,
                "answer": val if filled is not None and i <= filled else None,
                "required": 0,
            }
            for i, (path, kind, label, val) in enumerate(fields)
        ]

    def screen(filled):
        questions = []
        for path, kind, label, answer in fields:
            if preview and path != ("/data/note" if filled else "/data/start"):
                continue
            value = (
                {"datetime": "", "date": "1/15/2026"}.get(kind, answer)
                if filled
                else ("Not Supported by Web Entry" if kind == "datetime" else "")
            )
            questions.append(
                {
                    "label": label,
                    "answer": value,
                    "media": [],
                    "errors": [],
                    "required": False,
                }
            )
        return {"form": {"title": "Form", "questions": questions}}

    answers = [
        {
            "ix": str(i),
            "value": "14:30:00" if kind == "time" else val,
            "response": {"status": "accepted", "tree": tree(filled=i)},
        }
        for i, (_, kind, _, val) in enumerate(fields)
        if val is not None
    ]
    resends = [
        {
            "ix": row["ix"],
            "value": "14:30",
            "after": i + 1,
            "response": {"status": "accepted", "tree": deepcopy(answers[i + 1]["response"]["tree"])},
        }
        for i, row in enumerate(answers[:-1])
        if row["value"] == "14:30:00"
    ]
    reads = [["session_details", "200"]] * (len(answers) + len(resends) + 1)
    form = {
        "answers": answers,
        "resent": resends,
        "asked": reads + [["receiver_post_with_app_id", "201"]],
        "submitted": {"answers": {str(i): val for i, (_, _, _, val) in enumerate(fields)}},
    }
    opened = {
        "title": "Form",
        "tree": tree(None),
        "instanceXml": {"output": f'<data xmlns="urn:{side}"/>'},
    }
    fp = {
        "clock": "2026-01-15T10:30:00.000Z",
        "runs": [
            {
                "end": "submitted",
                "script": SCRIPT,
                "steps": [{"response": opened}, form],
            }
        ],
    }
    web = {
        "runs": [
            {
                "script": SCRIPT,
                "submit": "submitted",
                "viewport": "preview" if preview else None,
                "answers": ["answered"] * len(answers),
                "screens": [screen(False), screen(True)],
            }
        ]
    }
    return fp, web


@pytest.mark.parametrize("preview", [False, True])
def test_bound_widgets_and_gestures_leave_one_reviewed_web_difference_and_preserve_the_neighbors(
    preview,
):
    (fa, a), (fb, b) = observations("a", preview), observations("b", preview)
    b["runs"][0]["screens"][1]["form"]["questions"][-1]["label"] = "A changed neighbor"
    sites = align_screens(a, b, traces=(fa, fb), splits=SPLITS)
    assert sites == {
        "/runs/0/reviewedDateTime/~1data~1visit": (
            "form",
            "1.2",
            "xform",
            "data",
            "visit",
        )
    }
    rows = compare_json(
        a,
        b,
        check="proof3",
        document="doc",
        artifact="webapps@B",
        data_maps={"/runs/*/reviewedDateTime"},
    )
    assert [(d.path, d.kind) for d in rows] == [
        ("/runs/*/reviewedDateTime/*", "changed"),
        ("/runs/*/screens/*/form/questions/*/label", "changed"),
    ]


@pytest.mark.parametrize(
    "change",
    [
        "wrong-date",
        "wrong-time",
        "unexpected-media",
        "changed-required",
        "refused-control",
        "absent-screen",
        "renamed-widget",
        "duplicate-binding",
        "wrong-instance",
        "wrong-submit",
        "wrong-attempt",
        "changed-script",
        "unrelated-native-clock",
        "wrong-widget-order",
        "unexplained-native-input",
        "altered-source-support",
    ],
)
def test_an_unwitnessed_split_is_left_entirely_visible(change):
    (fa, a), (fb, b) = observations("a"), observations("b")
    run = b["runs"][0]
    steps = fb["runs"][0]["steps"]
    shown = run["screens"][1]["form"]["questions"]
    if change == "wrong-date":
        shown[1]["answer"] = "1/14/2026"
    elif change == "wrong-time":
        shown[2]["answer"] = "13:30"
    elif change == "unexpected-media":
        shown[2]["media"] = [{"kind": "audio"}]
    elif change == "changed-required":
        shown[2]["required"] = True
    elif change == "refused-control":
        run["answers"][1] = "invalid input"
    elif change == "absent-screen":
        run["screens"].pop()
    elif change == "renamed-widget":
        shown[2]["label"] = "Another Visit"
    elif change == "duplicate-binding":
        steps[0]["response"]["tree"][0]["binding"] = Q.date
        steps[0]["response"]["tree"][0]["datatype"] = "date"
    elif change == "wrong-instance":
        steps[0]["response"]["instanceXml"]["output"] = '<data xmlns="urn:other"/>'
    elif change == "wrong-submit":
        steps[1]["submitted"]["answers"]["2"] = "18:00"
    elif change == "wrong-attempt":
        steps[1]["answers"][0]["value"] = "1999-03-11"
    elif change == "changed-script":
        run["script"] = [{"menu": 3}]
    elif change == "unrelated-native-clock":
        fb["clock"] = "2000-03-11T01:02:03.000Z"
    elif change == "wrong-widget-order":
        shown[1:3] = reversed(shown[1:3])
    elif change == "unexplained-native-input":
        steps[1]["answers"][1]["response"]["status"] = "rejected"
    else:
        a["runs"][0]["screens"][0]["form"]["questions"][1]["answer"] = "1/15/2026"
    saved = deepcopy((a, b))
    assert align_screens(a, b, traces=(fa, fb), splits=SPLITS) == {}
    assert (a, b) == saved


@pytest.mark.parametrize("preview", [False, True])
@pytest.mark.parametrize(
    "target_layout",
    [
        ("start", Q, R, "note"),
        ("start", R, Q, "note"),
        ("start", Q, "note", R),
        ("start", R, "note", Q),
    ],
)
def test_two_identically_captioned_pairs_keep_the_order_of_each_other_and_the_ordinary_fields(preview, target_layout):
    layout = ("start", Q, R, "note")
    fa, a = observations("a", preview, layout)
    fb, b = observations("b", preview, target_layout)
    splits = {"1.2": FormSplit("urn:a", "urn:b", (Q, R))}
    original = deepcopy((a, b))
    sites = align_screens(a, b, traces=(fa, fb), splits=splits)
    if layout == target_layout:
        assert set(sites.values()) == {("form", "1.2", "xform", "data", leaf) for leaf in ("visit", "second")}
        assert a["runs"][0]["screens"] == b["runs"][0]["screens"]
        assert a["runs"][0]["answers"] == b["runs"][0]["answers"]
    else:
        assert sites == {}
        assert (a, b) == original


@pytest.mark.parametrize("preview", [False, True])
def test_moving_a_later_gesture_before_the_split_stays_visible_at_the_web_apps_comparison(preview):
    from proof.checks.served import webapps_differences

    (fa, a), (fb, b) = observations("a", preview), observations("b", preview)
    gestures = fb["runs"][0]["steps"][1]["answers"]
    gestures.insert(0, gestures.pop())
    sites = {}
    rows = webapps_differences(
        a,
        b,
        check="proof3",
        document="example",
        artifact="webapps@B",
        traces=(fa, fb),
        splits=SPLITS,
        reviewed_sites=sites,
    )
    assert not sites
    assert any(d.path == "/runs/*/answers/*" for d in rows)
    assert all("/reviewedDateTime/" not in d.path for d in rows)


@pytest.mark.parametrize("changed", [None, "retry-value", "repeat-instance", "resend-trigger"])
def test_existing_repeat_retry_and_reconciliation_must_still_belong_to_the_same_gestures(changed):
    from proof.checks.served import webapps_differences

    (fa, a), (fb, b) = observations("a"), observations("b")
    for native, browser in ((fa, a), (fb, b)):
        opened, fill = native["runs"][0]["steps"]
        last = fill["answers"].pop()
        previous_ix = last["ix"]
        occurrence = 2 if native is fb and changed == "repeat-instance" else 1
        ix = f"{previous_ix}_{occurrence},0"
        # The same retry on a repeated ordinary field, indexed by repeat occurrence in Formplayer.
        # The topology of the bound question is identical for both sides of the first publish.
        for response in [
            opened["response"],
            last["response"],
            *(r["response"] for r in fill["answers"] + fill["resent"]),
        ]:
            ordinary = response["tree"].pop()
            ordinary.update(ix=ix, binding="/data/round/note")
            response["tree"].append({"type": "sub-group", "ix": f"{previous_ix}_{occurrence}", "children": [ordinary]})
        last["ix"] = ix
        retry = deepcopy(last)
        retry["value"] = "changed" if native is fb and changed == "retry-value" else "first attempt"
        retry["response"]["status"] = "validation-error"
        fill["answers"].extend((retry, last))
        sent = fill["submitted"]["answers"]
        sent[ix] = sent.pop(previous_ix)
        fill["asked"].insert(0, ["session_details", "200"])
        browser["runs"][0]["answers"].append("answered")
    if changed == "resend-trigger":
        fb["runs"][0]["steps"][1]["resent"][0]["after"] += 1
    sites = {}
    rows = webapps_differences(
        a,
        b,
        check="proof3",
        document="example",
        artifact="webapps@B",
        traces=(fa, fb),
        splits=SPLITS,
        reviewed_sites=sites,
    )
    if changed:
        assert not sites
        assert any(r.path == "/runs/*/answers/*" for r in rows)
    else:
        assert [r.path for r in rows] == ["/runs/*/reviewedDateTime/*"]
        assert len(sites) == 1
