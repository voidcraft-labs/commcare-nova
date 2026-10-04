"""The rule ``case-block-position`` is sound: a repeat item's own case block before or after the item's answers
is processed alike by Core and by HQ.

Contract: the rule erases, in a session trace's submissions, where a case
block that is the child of an element other than the data node stands among
that element's children that hold no case block: HQ's build writes a
repeat's subcase block first in the item, Nova's local archive after the
item's answers. The plausible failures: Core or HQ applying the blocks
otherwise for that place (so the two archives would leave different cases),
and the rule moving a block past another block, which changes the order the
blocks are applied in.

HQ's build of a corpus document whose repeat opens a subcase per item is
installed as it is and with that block moved after the item's answers:
Core's sessions differ only in the submissions' order of the item's
children, which the rule erases; the case database Core leaves and HQ's
processing of every submission are the same. A block moved past another
block is applied in another order: HQ's build of a registration that opens
a child case, installed as it is and with its own case block moved before
the child's (harness finding 37), leaves Core's case database in another
order, and the rule leaves the block where it stands, as it leaves a block
beside another block in any submission.
"""

from __future__ import annotations

from lxml import etree

from proof.rules.case_block_position import RULE, normalize
from proof.rules.conftest import published, runs_alike, shown

DOCUMENT = "case-capture-repeat"
# A registration whose form opens its own case and a child case beside it, at the data node.
REGISTRATION = "case-extension-registration"
FORM = "modules-0/forms-0.xml"
CASE = "{http://commcarehq.org/case/transaction/v2}case"
XFORMS = "{http://www.w3.org/2002/xforms}"


def _block_last(form):
    root = etree.fromstring(form)
    data = root.find(f"{{http://www.w3.org/1999/xhtml}}head/{XFORMS}model/{XFORMS}instance")[0]
    moved = 0
    for block in list(data.iter(CASE)):
        parent = block.getparent()
        if parent is not data:
            parent.remove(block)
            parent.append(block)
            moved += 1
    assert moved, "the form holds no case block below its data node"
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)


def test_a_repeat_items_case_block_is_processed_alike_wherever_it_stands(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        built = app.spell()
        files = dict(built.build.files)
        files[FORM] = _block_last(files[FORM])
        _, _, raw = runs_alike(app, core_runner, built.build, built.build, second_files=files)
        _, _, after = runs_alike(app, core_runner, built.build, built.build, second_files=files, rules=(RULE,))

    assert raw, "moving the block changed no submission, so the sessions submit no repeat item"
    assert all(path.endswith("/order()") and "/submission/" in path for _, path, _ in shown(raw)), shown(raw)
    assert after == [], shown(after)


def _own_block_first(form):
    root = etree.fromstring(form)
    data = root.find(f"{{http://www.w3.org/1999/xhtml}}head/{XFORMS}model/{XFORMS}instance")[0]
    own = data.find(CASE)
    assert own is not None and any(child.find(CASE) is not None for child in data), "no block beside the own"
    data.insert(0, own)
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)


def test_a_block_moved_past_another_block_leaves_the_cases_in_another_order(rule_documents, hq, core_runner):
    with published(rule_documents[REGISTRATION], core_runner) as app:
        built = app.spell()
        files = dict(built.build.files)
        files[FORM] = _own_block_first(files[FORM])
        _, _, after = runs_alike(app, core_runner, built.build, built.build, second_files=files, rules=(RULE,))

    left = shown(after)
    assert any("/caseDb" in path for _, path, _ in left), left
    assert any("/submission/" in path and path.endswith("/order()") for _, path, _ in left), left


def test_a_block_beside_another_block_is_left():
    submission = (
        '<data xmlns="http://example.org/f"><item><answer/><wrapper><case xmlns="http://commcarehq.org/case/'
        'transaction/v2" case_id="a"/></wrapper><case xmlns="http://commcarehq.org/case/transaction/v2" '
        'case_id="b"/></item></data>'
    )
    trace = {"runs": [{"trace": [{"submission": submission}]}]}
    assert normalize(trace)["runs"][0]["trace"][0]["submission"] == submission
