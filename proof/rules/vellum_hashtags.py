"""Vellum's ``<vellum:hashtags>`` and ``<vellum:hashtagTransforms>`` in a form's head, which Core passes over.

Vellum keeps, in the form's head, the map from each hashtag a form's
expressions use to the path it stands for, and the prefixes it rewrites
(``Vellum/src/writer.js::createXForm``, which writes both from
``form.knownExternalReferences()``); a save
writes, rewrites or drops them as the expressions it holds ask. HQ's build
carries them into the forms it builds, and Core's parser passes over both:
it reads ``h:head`` for its title, meta and model and names these two as
markup it ignores without a warning (commcare-core
``XFormParser.parseElement``, ``suppressWarningArr``), and they hold text,
no element it would read.

The rule removes both elements from the head of a form HQ holds or builds.
"""

from __future__ import annotations

from proof.rules import SpellingRule
from proof.rules._xforms import VELLUM, XHTML, is_xform, tag

_NAMES = frozenset({tag(VELLUM, "hashtags"), tag(VELLUM, "hashtagTransforms")})


def normalize(root):
    if not is_xform(root):
        return root
    for head in root.findall(tag(XHTML, "head")):
        for child in [child for child in head if child.tag in _NAMES]:
            head.remove(child)
    return root


RULE = SpellingRule(
    "vellum-hashtags",
    ("form:*", "*/form:*"),
    "Vellum's hashtag maps in a form's head, which Core's parser passes over (XFormParser.parseElement).",
    normalize,
)
