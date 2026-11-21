"""A reviewed hidden message can move the following label's FormIndex in an otherwise unchanged worker submission."""

import pytest

from proof.checks import served
from proof.checks.formplayer_message_carriers import SUFFIX
from proof.checks.native_constraint_helpers import helper_sites
from proof.checks.test_native_constraint_helpers import (
    FILE,
    MSG_NODE,
    PLACES,
    installed,
    trace,
)


def records(side):
    # The constraint lives on kids, but its label interpolates adults, a separate answer.
    files = installed(side)
    xml = files[FILE].replace('output value="/data/kids"', 'output value="/data/adults"')
    xml = xml.replace("if(count(/data/kids)", "if(count(/data/adults)").replace(
        "'v'), /data/kids,", "'v'), /data/adults,"
    )
    files[FILE] = xml.replace("</h:body>", '<trigger ref="/data/summary"/></h:body>').replace(
        "</data>", "<summary/></data>"
    )
    actual = trace(side)
    steps = actual["runs"][0]["steps"]
    ix = "2" if side == "a" else "3"
    tree = [
        {"ix": "1", "type": "question", "binding": "/data/kids", "answer": 1},
        {
            "ix": ix,
            "type": "question",
            "control": 9,
            "datatype": "info",
            "binding": "/data/summary",
            "caption": "Done",
        },
    ]
    xml = steps[0]["response"]["instanceXml"]["output"].replace("</data>", "<summary/></data>")
    steps[0]["response"]["instanceXml"]["output"] = xml
    steps[1] = {
        "answers": [
            {
                "ix": "1",
                "value": 1,
                "response": {
                    "status": "accepted",
                    "tree": tree,
                    "instanceXml": {"output": xml},
                },
            }
        ],
        "submitted": {"answers": {"1": 1, ix: "OK"}, "prevalidated": True},
        "submit": {"status": "success"},
    }
    return files, actual


def judged(a, b):
    originals = served.formplayer_differences(
        a[1],
        b[1],
        check="proof3",
        document="example",
        artifact="formplayer@B",
        xmlns={"urn:b": "urn:a"},
    )
    return helper_sites(
        originals,
        before_files=a[0],
        after_files=b[0],
        before_trace=a[1],
        after_trace=b[1],
        declared=PLACES,
    )


def test_the_trigger_moves_with_the_installed_carrier_even_when_a_sibling_value_changes():
    a, b = records("a"), records("b")
    fill = b[1]["runs"][0]["steps"][1]
    fill["answers"][0]["response"]["tree"][0]["answer"] = 2
    sites, found = judged(a, b)
    marked = [row for row in found if row.path.endswith(SUFFIX)]
    assert {(row.kind, row.before, row.after) for row in marked} == {
        ("changed", "2", "3"),
        ("removed", "OK", None),
        ("added", None, "OK"),
    }
    assert all(sites[row.artifact, row.at] == ("form", "1.2", "xform", "data", MSG_NODE) for row in marked)
    sibling = next(row for row in found if row.at.endswith("/tree/0/answer"))
    assert (sibling.before, sibling.after) == (1, 2)
    assert (sibling.artifact, sibling.at) not in sites


@pytest.mark.parametrize(
    "change",
    [
        "order",
        "visible-order",
        "trigger-value",
        "stale-ix",
        "duplicate-ix",
        "changed-label",
        "wrong-expression",
        "missing-output",
        "ambiguous-output",
        "changed-output",
        "ambiguous-native-output",
        "not-a-trigger",
        "wrong-form",
    ],
)
def test_a_different_binding_value_order_or_installed_carrier_keeps_the_native_indices_visible(
    change,
):
    a, b = records("a"), records("b")
    files, actual = b
    steps = actual["runs"][0]["steps"]
    fill = steps[1]
    tree = fill["answers"][0]["response"]["tree"]
    if change == "order":
        files[FILE] = files[FILE].replace(
            '<input ref="/data/adults"/><input ref="/data/kids"/>',
            '<input ref="/data/kids"/><input ref="/data/adults"/>',
        )
    elif change == "visible-order":
        tree.reverse()
    elif change == "trigger-value":
        fill["submitted"]["answers"]["3"] = "Cancel"
    elif change == "stale-ix":
        fill["submitted"]["answers"]["2"] = "OK"
    elif change == "duplicate-ix":
        tree[0]["ix"] = "3"
    elif change == "changed-label":
        tree[1]["caption"] = "Something else"
    elif change == "wrong-expression":
        files[FILE] = files[FILE].replace("if(count(/data/adults)", "if(count(/data/kids)")
    elif change == "missing-output":
        # A separate field that the constraint message still interpolates is absent from the installed model.
        files[FILE] = files[FILE].replace("<adults/>", "")
    elif change == "ambiguous-output":
        files[FILE] = files[FILE].replace("<adults/>", "<adults/><adults/>")
    elif change in ("changed-output", "ambiguous-native-output"):
        xml = steps[0]["response"]["instanceXml"]["output"]
        replacement = "<adults>9</adults>" if change == "changed-output" else "<adults>2</adults><adults>2</adults>"
        steps[0]["response"]["instanceXml"]["output"] = xml.replace("<adults>2</adults>", replacement)
    elif change == "not-a-trigger":
        files[FILE] = files[FILE].replace('<trigger ref="/data/summary"/>', '<input ref="/data/summary"/>')
    else:
        files["suite.xml"] = files["suite.xml"].replace("urn:b", "urn:other")
    sites, found = judged(a, b)
    assert not any(row.path.endswith(SUFFIX) for row in found)
    assert any(row.at.endswith("/ix") and (row.artifact, row.at) not in sites for row in found)
