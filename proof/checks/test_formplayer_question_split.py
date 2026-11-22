"""Preserve the offered widget, every neighboring gesture and the instance HQ actually received."""

from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

import pytest

from proof.checks import native_question_split, served
from proof.checks.native_question_split import FormSplit, Split

WHEN = Split("/data/when", "/data/day", "/data/time")
FORMS = {"0.0": FormSplit("before", "after", (WHEN,))}
CLOCK = "2026-01-15T10:30:00.000Z"
DAY, TIME = "2026-01-15", "14:30"


def _question(ix, node, datatype, value=None):
    return {
        "ix": str(ix),
        "binding": "/data/" + node,
        "question_id": node,
        "type": "question",
        "datatype": datatype,
        "caption": "When" if node != "neighbor" else "Neighbor",
        "caption_markdown": None,
        "required": 0,
        "answer": value,
    }


def _instance(after, filled=False):
    paired = (f"<day>{DAY if filled else ''}</day><time>{TIME + ':00.000' if filled else ''}</time>") if after else ""
    joined = f"{DAY}T{TIME}:00.000Z" if after and filled else ""
    return f'<data xmlns="{"after" if after else "before"}">{paired}<when>{joined}</when><neighbor>{"hi" if filled else ""}</neighbor></data>'


def _record(after, prior=False):
    shift = int(prior)

    def tree(filled):
        special = (
            [
                _question(shift, "day", "date", DAY if filled else None),
                _question(shift + 1, "time", "time", TIME if filled else None),
            ]
            if after
            else [_question(shift, "when", "datetime")]
        )
        prior_tree = [_question(0, "previous", "time", TIME if filled else None)] if prior else []
        return [
            *prior_tree,
            *special,
            _question(shift + (2 if after else 1), "neighbor", "str", "hi" if filled else None),
        ]

    def sent(ix, value):
        return {"ix": str(ix), "value": value, "response": {"status": "accepted", "tree": tree(True)}}

    answers = (
        [sent(shift, DAY), sent(shift + 1, TIME + ":00"), sent(shift + 2, "hi")] if after else [sent(shift + 1, "hi")]
    )
    resend = [{**sent(shift + 1, TIME), "after": shift + 2}] if after else []
    submitted = (
        {str(shift): DAY, str(shift + 1): TIME, str(shift + 2): "hi"}
        if after
        else {str(shift): None, str(shift + 1): "hi"}
    )
    if prior:
        answers.insert(0, sent(0, TIME + ":00"))
        resend.insert(0, {**sent(0, TIME), "after": 1})
        submitted["0"] = TIME
    receipt = [["session_details", "200"]] * (1 + len(answers) + len(resend)) + [["receiver_post_with_app_id", "201"]]
    return {
        "clock": CLOCK,
        "runs": [
            {
                "script": [{"menu": 0}],
                "steps": [
                    {
                        "response": {
                            "session_id": "session",
                            "tree": tree(False),
                            "instanceXml": {"output": _instance(after)},
                        }
                    },
                    {
                        "answers": answers,
                        "resent": resend,
                        "asked": receipt,
                        "submitted": {"answers": submitted, "prevalidated": True},
                        "submissions": [{"instance": _instance(after, True)}],
                    },
                ],
            }
        ],
    }


def _compare(a, b, forms=FORMS):
    sites = {}
    rows = served.formplayer_differences(
        a,
        b,
        check="proof3",
        document="d",
        artifact="formplayer@B",
        splits=forms,
        reviewed_sites=sites,
        xmlns={"after": "before"},
    )
    return rows, sites


def test_a_reviewed_split_holds_only_the_ordered_new_widgets_the_worker_used():
    a, b = _record(False), _record(True)
    original = deepcopy((a, b))
    rows, sites = _compare(a, b)
    assert [(r.path, r.before, r.after) for r in rows] == [
        ("/runs/*/reviewedDateTime/*", "unanswered datetime", DAY + " " + TIME)
    ]
    [r] = rows
    assert sites == {(r.artifact, r.at): ("form", "0.0", "xform", "data", "when")}
    assert (a, b) == original


@pytest.mark.parametrize(
    "mutation",
    [
        "neighbor",
        "wrong_ix",
        "order",
        "required",
        "bad_time",
        "accepted",
        "resent",
        "moved_gesture",
        "asked",
        "receiver",
        "joined",
        "xml_extra",
        "different_install",
    ],
)
def test_another_gesture_widget_receipt_or_submission_is_still_a_difference(mutation):
    a, b = _record(False), _record(True)
    first, filled = b["runs"][0]["steps"]
    forms = FORMS
    if mutation == "neighbor":
        first["response"]["tree"][-1]["caption"] = "Something else"
    if mutation == "wrong_ix":
        first["response"]["tree"][-1]["ix"] = "1"
    if mutation == "order":
        first["response"]["tree"].reverse()
    if mutation == "required":
        first["response"]["tree"][1]["required"] = 1
    if mutation == "bad_time":
        filled["submitted"]["answers"]["1"] = "09:29"
    if mutation == "accepted":
        filled["answers"][0]["response"]["status"] = "validation-error"
    if mutation == "resent":
        filled["resent"][0]["after"] = 0
    if mutation == "moved_gesture":
        filled["answers"].insert(0, filled["answers"].pop())
    if mutation == "asked":
        filled["asked"][1][1] = "500"
    if mutation == "receiver":
        filled["asked"].insert(0, filled["asked"].pop())
    if mutation == "joined":
        filled["submissions"][0]["instance"] = filled["submissions"][0]["instance"].replace(
            "14:30:00.000Z", "04:30:00.000Z"
        )
    if mutation == "xml_extra":
        filled["submissions"][0]["instance"] = filled["submissions"][0]["instance"].replace("<day>", "<day new='data'>")
    if mutation == "different_install":
        forms = {"0.0": replace(FORMS["0.0"], after_namespace="a-different-form")}
    rows, sites = _compare(a, b, forms)
    assert rows and not sites
    assert not any(row.path == "/runs/*/reviewedDateTime/*" for row in rows)


@pytest.mark.parametrize("label", ["_When_", "__When__", "    When"])
def test_the_copied_markdown_of_a_formatted_label_is_an_observable_change(label):
    a, b = _record(False), _record(True)
    for trace in (a, b):
        opened, filled = trace["runs"][0]["steps"]
        for response in [opened["response"], *(r["response"] for r in filled["answers"] + filled["resent"])]:
            for node in response["tree"]:
                if node["binding"] in (WHEN.original, WHEN.date, WHEN.time):
                    node["caption"] = label
                    if trace is b:
                        node["caption_markdown"] = label
    rows, sites = _compare(a, b)
    assert rows and not sites


def test_resending_a_previous_widget_belongs_to_the_next_actual_gesture_in_order():
    a, b = _record(False, prior=True), _record(True, prior=True)
    [reviewed], sites = _compare(a, b)
    assert reviewed.path == "/runs/*/reviewedDateTime/*"
    fill = b["runs"][0]["steps"][-1]
    fill["resent"][0]["after"] = 2
    rows, sites = _compare(a, b)
    assert rows and not sites
    fill["resent"][0]["after"] = 1
    fill["resent"].reverse()
    rows, sites = _compare(a, b)
    assert rows and not sites


@pytest.mark.parametrize(
    "mutation", ["reversed", "mixed_text", "moved_group", "transient_binding", "neighbor_transient_binding"]
)
def test_a_native_echo_or_received_xml_cannot_borrow_the_final_widget_or_another_node(mutation):
    a, b = _record(False), _record(True)
    step = b["runs"][0]["steps"][-1]
    xml = step["submissions"][0]["instance"]
    day = f"<day>{DAY}</day>"
    clock = f"<time>{TIME}:00.000</time>"
    if mutation == "reversed":
        xml = xml.replace(day + clock, clock + day)
    elif mutation == "mixed_text":
        xml = xml.replace(clock, clock + "worker data")
    elif mutation == "moved_group":
        xml = xml.replace("<neighbor>hi</neighbor>", "").replace(day, "<neighbor>hi</neighbor>" + day)
    elif mutation == "transient_binding":
        step["answers"][0]["response"]["tree"][1]["binding"] = "/data/neighbor"
    else:
        node = step["answers"][1]["response"]["tree"][-1]
        node["binding"], node["question_id"] = "/data/other", "other"
    step["submissions"][0]["instance"] = xml
    rows, sites = _compare(a, b)
    assert rows and not sites


def _files(after, join=None):
    namespace = "after" if after else "before"
    if join is None:
        join = "date(format-date(if(/data/day = '' or /data/time = '', '', concat(/data/day, 'T', /data/time)), '%Y-%m-%dT%H:%M:%S.%3%Z'))"
    binds = '<bind nodeset="/data/day" type="xsd:date"/><bind nodeset="/data/time" type="xsd:time"/>' if after else ""
    hidden = f' calculate="{join}"' if after else ""
    body = '<input ref="/data/day"/><input ref="/data/time"/>' if after else '<input ref="/data/when"/>'
    form = f'''<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms"
        xmlns:xsd="http://www.w3.org/2001/XMLSchema"><h:head><h:title>Form</h:title><model>
        <instance>{_instance(after)}</instance>{binds}<bind nodeset="/data/when" type="xsd:dateTime"{hidden}/>
        </model></h:head><h:body>{body}</h:body></h:html>'''
    suite = f"""<suite><xform><resource><location authority="local">./modules-0/forms-0.xml</location></resource></xform>
        <entry><form>{namespace}</form><command id="m0-f0"/></entry></suite>"""
    return {"modules-0/forms-0.xml": form, "suite.xml": suite}


def test_both_installed_forms_must_prove_the_exact_reviewed_paths_and_the_hidden_join():
    places = ["/form/0.0/xform" + path for path in (WHEN.original, WHEN.date, WHEN.time)]
    doc = SimpleNamespace(first_publish_places=[(native_question_split.CHANGE, places)])
    old, new = _files(False), _files(True)
    assert native_question_split.installed(doc, old, new) == FORMS
    assert native_question_split.installed(doc, old, _files(True, "now()")) == {}
    assert native_question_split.installed(doc, old, new, after_differing=["modules-0/forms-0.xml"]) == {}
    assert native_question_split.installed(doc, old, new, before_differing=["suite.xml"]) == {}
    changed_path = "installed/actual.xml"
    orphan = {
        **new,
        "suite.xml": new["suite.xml"].replace("modules-0/forms-0.xml", changed_path),
        changed_path: old["modules-0/forms-0.xml"].replace('xmlns="before"', 'xmlns="after"'),
    }
    assert native_question_split.installed(doc, old, orphan) == {}
    orphan[changed_path] = new["modules-0/forms-0.xml"]
    assert native_question_split.installed(doc, old, orphan) == FORMS
    wrong_suite = {**new, "suite.xml": new["suite.xml"].replace("<form>after", "<form>other")}
    assert native_question_split.installed(doc, old, wrong_suite) == {}
    doc.first_publish_places = [(native_question_split.CHANGE, places[:-1])]
    assert native_question_split.installed(doc, old, new) == {}


def test_adjacent_reviewed_pairs_do_not_trade_gestures_when_their_labels_are_identical():
    second = Split("/data/later", "/data/otherday", "/data/othertime")
    forms = {"0.0": replace(FORMS["0.0"], questions=(WHEN, second))}

    def trace(after):
        # Keep two independently owned datetime widgets between the same ordinary neighbors.
        source = _record(after)
        opened, filled = source["runs"][0]["steps"]

        def expand(response):
            nodes = response["tree"]
            new = deepcopy(nodes[:-1])
            for node in new:
                key = {WHEN.original: second.original, WHEN.date: second.date, WHEN.time: second.time}[node["binding"]]
                node["binding"] = key
                node["question_id"] = key.rsplit("/", 1)[1]
                node["ix"] = str(int(node["ix"]) + len(new))
            nodes[-1]["ix"] = str(int(nodes[-1]["ix"]) + len(new))
            nodes[-1:-1] = new

        for response in [opened["response"], *(a["response"] for a in filled["answers"] + filled["resent"])]:
            expand(response)
        for holder, key in [(opened["response"]["instanceXml"], "output"), (filled["submissions"][0], "instance")]:
            xml = holder[key]
            start = xml.index("<day>") if after else xml.index("<when>")
            content = xml[start : xml.index("<neighbor>")]
            extra = content.replace("when>", "later>").replace("day>", "otherday>").replace("time>", "othertime>")
            holder[key] = xml.replace(content, content + extra)
        final = filled["answers"][-1]
        final["ix"] = "4" if after else "2"
        if after:
            extras = deepcopy(filled["answers"][:2])
            extras[0]["ix"], extras[1]["ix"] = "2", "3"
            filled["answers"][2:2] = extras
            new = deepcopy(filled["resent"][0])
            new.update(ix="3", after=4)
            filled["resent"].append(new)
            filled["submitted"]["answers"] = {"0": DAY, "1": TIME, "2": DAY, "3": TIME, "4": "hi"}
        else:
            filled["submitted"]["answers"] = {"0": None, "1": None, "2": "hi"}
        n = 1 + len(filled["answers"]) + len(filled["resent"])
        filled["asked"] = [["session_details", "200"]] * n + [["receiver_post_with_app_id", "201"]]
        return source

    a, b = trace(False), trace(True)
    rows, sites = _compare(a, b, forms)
    assert len(rows) == len(sites) == 2
    fill = b["runs"][0]["steps"][-1]
    fill["answers"][:4] = [*fill["answers"][2:4], *fill["answers"][:2]]
    fill["resent"][:] = [dict(fill["resent"][1], after=2), dict(fill["resent"][0], after=4)]
    rows, sites = _compare(a, b, forms)
    assert rows and not sites
