"""The rule ``vellum-attributes`` is sound: HQ builds a form the same whatever its Vellum-namespace attributes say.

Contract (plan work item 11, "Spelling rules"): the rule erases exactly the
attributes in Vellum's namespace, and HQ's build output does not depend on
them. The plausible failures: HQ reading one of them before it strips them
(so a Vellum save would change what it builds), and the rule erasing an
attribute outside Vellum's namespace, which Core reads.

A corpus document with repeats, groups, case blocks and calculations is
published, and its form is stored twice: as Nova writes it, and with a
Vellum-namespace twin of every attribute Vellum writes one for (``ref``,
``nodeset``, ``calculate``, ``relevant``, ``constraint``, ``required``,
``value``), each holding the path written as a hashtag, and a second
save's ``vellum:vellum__required`` beside each ``required``. HQ's two builds
are the same file for file; the stored sources differ by those attributes
alone, which the rule erases; the same rule leaves a changed ``relevant``.
"""

from __future__ import annotations

from proof.rules.conftest import build_differences, published, rewritten, shown, stored_differences
from proof.rules.vellum_attributes import RULE

DOCUMENT = "case-capture-repeat"
VELLUM = "http://commcarehq.org/xforms/vellum"
SHADOWED = ("ref", "nodeset", "calculate", "relevant", "constraint", "required", "value")


def _hashtags(value):
    return value.replace("/data/", "#form/")


def _with_vellum_twins(root):
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        for name in SHADOWED:
            if element.get(name) is not None:
                element.set(f"{{{VELLUM}}}{name}", _hashtags(element.get(name)))
        if element.get("required") is not None:
            element.set(f"{{{VELLUM}}}vellum__required", element.get("required"))


def _relevant_changed(root):
    bind = next(element for element in root.iter() if element.get("relevant") is not None)
    bind.set("relevant", f"({bind.get('relevant')}) and true()")


def test_hq_builds_a_form_alike_whatever_its_vellum_attributes(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        vellum = app.spell(sources={"0.0": rewritten(_with_vellum_twins)})
        changed = app.spell(sources={"0.0": rewritten(_relevant_changed)})

    spelled = stored_differences(nova.stored, vellum.stored)
    assert spelled, "the Vellum spelling stored nothing different, so the test shows nothing"
    assert all("@vellum:" in path for _, path, _ in shown(spelled)), shown(spelled)
    assert stored_differences(nova.stored, vellum.stored, rules=(RULE,)) == []
    assert build_differences(nova.build, vellum.build) == [], shown(build_differences(nova.build, vellum.build))

    # Not every attribute: a relevance Core reads stays a difference, in the stored form and in the build.
    assert shown(stored_differences(nova.stored, changed.stored, rules=(RULE,)))
    assert build_differences(nova.build, changed.build)
