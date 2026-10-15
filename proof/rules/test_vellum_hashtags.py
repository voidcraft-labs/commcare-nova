"""The rule ``vellum-hashtags`` is sound: Core runs a form alike with or without Vellum's hashtag maps in its head.

Contract: the rule erases ``<vellum:hashtags>`` and
``<vellum:hashtagTransforms>`` in a form's head, which Vellum's save writes,
rewrites or drops. HQ's build carries them into the forms it builds, so the
proof is Core's: the plausible failures are Core reading them (so a save
would change what a device does) and HQ's build changing anything else for
them, and the rule erasing another element of the head.

Nova writes neither map. A corpus document whose form reads a property HQ's
case schema lists is published as Nova writes it, with the two maps a Vellum
save writes for that read inserted in its head, and with the map holding
another hashtag: HQ's builds differ by the two elements alone, which the
rule erases, and Core's sessions on the builds compare equal. A changed
title is left.
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

DOCUMENT = "standard-case-reads"
VELLUM = "http://commcarehq.org/xforms/vellum"
XHTML = "http://www.w3.org/1999/xhtml"
HEAD = f"{{{XHTML}}}head"
MODEL = "{http://www.w3.org/2002/xforms}model"
# What a Vellum save writes into this document's form for its one read of a listed property, ``case_name``
# (``Vellum/src/writer.js::createXForm``: the references ``form.knownExternalReferences`` holds, each mapped to
# null, and the prefix HQ's session schema gives the loaded case, ``app_schemas/session_schema.py``).
SAVED_HASHTAGS = '{"#case/case_name":null}'
SAVED_TRANSFORMS = (
    '{"prefixes":{"#case/":"instance(\'casedb\')/casedb/case[@case_id = '
    "instance('commcaresession')/session/data/case_id]/\"}}"
)


def _maps(root):
    return [child for child in root.find(HEAD) if etree.QName(child).namespace == VELLUM]


def _with_maps(hashtags):
    def insert(root):
        assert not _maps(root), "Nova's form carries a hashtag map"
        model = root.find(HEAD).find(MODEL)
        for name, text in reversed((("hashtags", hashtags), ("hashtagTransforms", SAVED_TRANSFORMS))):
            element = etree.Element(f"{{{VELLUM}}}{name}", nsmap={"vellum": VELLUM})
            element.text = text
            model.addnext(element)

    return insert


def _retitled(root):
    title = root.find(HEAD).find(f"{{{XHTML}}}title")
    title.text = f"{title.text} again"


def test_core_runs_a_form_alike_whatever_its_hashtag_maps(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell(sources={"0.0": rewritten()})
        saved = app.spell(sources={"0.0": rewritten(_with_maps(SAVED_HASHTAGS))})
        changed = app.spell(
            sources={"0.0": rewritten(_with_maps(SAVED_HASHTAGS.rstrip("}") + ',"#case/unlisted":null}'))}
        )
        retitled = app.spell(sources={"0.0": rewritten(_retitled)})
        runs = [runs_alike(app, core_runner, nova.build, other.build)[2] for other in (saved, changed)]

    for other in (saved, changed):
        built = shown(build_differences(nova.build, other.build))
        assert built and all("/hashtag" in path for _, path, _ in built), built
        assert build_differences(nova.build, other.build, rules=(RULE,)) == []
        assert stored_differences(nova.stored, other.stored, rules=(RULE,)) == []
    assert all(found == [] for found in runs), [shown(found) for found in runs]
    assert shown(stored_differences(nova.stored, retitled.stored, rules=(RULE,)))
