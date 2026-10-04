"""The rule ``vellum-hashtags`` is sound: Core runs a form alike with or without Vellum's hashtag maps in its head.

Contract: the rule erases ``<vellum:hashtags>`` and
``<vellum:hashtagTransforms>`` in a form's head, which Vellum's save writes,
rewrites or drops. HQ's build carries them into the forms it builds, so the
proof is Core's: the plausible failures are Core reading them (so a save
would change what a device does) and HQ's build changing anything else for
them, and the rule erasing another element of the head.

A corpus document whose form Nova writes with both maps is published as
Nova writes it, with both maps taken out (the save that drops them), and
with the map holding another hashtag: HQ's builds differ by the two
elements alone, which the rule erases, and Core's sessions on the builds
compare equal. A changed title is left.
"""

from __future__ import annotations

from lxml import etree

from proof.rules.conftest import (
    build_differences,
    published,
    rewritten,
    runs_alike,
    shown,
    stored_differences,
)
from proof.rules.vellum_hashtags import RULE

DOCUMENT = "expander-form-hashtag-expansion-emits-the-editor-1daa5537-0"
VELLUM = "http://commcarehq.org/xforms/vellum"
HEAD = "{http://www.w3.org/1999/xhtml}head"


def _maps(root):
    return [child for child in root.find(HEAD) if etree.QName(child).namespace == VELLUM]


def _dropped(root):
    maps = _maps(root)
    assert maps, "Nova's form carries no hashtag map"
    for element in maps:
        root.find(HEAD).remove(element)


def _rewritten_map(root):
    hashtags = next(element for element in _maps(root) if etree.QName(element).localname == "hashtags")
    hashtags.text = hashtags.text.rstrip("}") + ', "#case/unlisted": "instance(\'casedb\')/casedb/case/unlisted"}'


def _retitled(root):
    title = root.find(HEAD).find("{http://www.w3.org/1999/xhtml}title")
    title.text = f"{title.text} again"


def test_core_runs_a_form_alike_whatever_its_hashtag_maps(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        dropped = app.spell(sources={"0.0": rewritten(_dropped)})
        changed = app.spell(sources={"0.0": rewritten(_rewritten_map)})
        retitled = app.spell(sources={"0.0": rewritten(_retitled)})
        runs = [runs_alike(app, core_runner, nova.build, other.build)[2] for other in (dropped, changed)]

    for other in (dropped, changed):
        built = shown(build_differences(nova.build, other.build))
        assert built and all("/hashtag" in path for _, path, _ in built), built
        assert build_differences(nova.build, other.build, rules=(RULE,)) == []
        assert stored_differences(nova.stored, other.stored, rules=(RULE,)) == []
    assert all(found == [] for found in runs), [shown(found) for found in runs]
    assert shown(stored_differences(nova.stored, retitled.stored, rules=(RULE,)))
