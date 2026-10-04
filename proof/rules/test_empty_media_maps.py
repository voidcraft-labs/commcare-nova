"""The rule ``empty-media-maps`` is sound: HQ builds a menu media map holding no path as it builds ``{}``.

Contract: the rule erases a menu media map whose every value is ``""``, as
HQ's module and form settings saves write one. The plausible failures: a
reader of the map telling ``""`` from no entry (so the saves would change the
build), and the rule erasing a ``""`` beside a path, which changes the path
HQ's fallback finds for that language.

A corpus document is published with its module's, its form's, its case
list menu item's and its registration action's media maps as Nova writes
them (``{}``), and with ``""`` for each language: HQ builds both alike and
the rule erases the difference. A module's map holding a path for another
language builds a menu image for the app's language, and beside ``""`` for
the app's language none, and the rule leaves the ``""``.
"""

from __future__ import annotations

from proof.rules.conftest import (
    assert_same_build,
    assert_spelled,
    build_differences,
    edited,
    published,
    shown,
    stored_differences,
)
from proof.rules.empty_media_maps import RULE

DOCUMENT = "arithmetic"
MEDIA = ("media_image", "media_audio")
# A language the app does not hold, which sorts after its own, and an image for it.
OTHER_LANGUAGE = "zz"
IMAGE = "jr://file/commcare/image/module0.png"


def _blank_everywhere(doc):
    langs = doc["langs"]
    module = doc["modules"][0]
    for holder in (module, module["forms"][0], module["case_list"], module["case_list_form"]):
        for key in MEDIA:
            holder[key] = {lang: "" for lang in langs}


def _beside_a_path(blank):
    """The module's image map holding a path for another language, and ``""`` for each of the app's where
    ``blank``."""

    def change(doc):
        assert OTHER_LANGUAGE not in doc["langs"] and all(lang < OTHER_LANGUAGE for lang in doc["langs"])
        image = {lang: "" for lang in doc["langs"]} if blank else {}
        doc["modules"][0]["media_image"] = {**image, OTHER_LANGUAGE: IMAGE}

    return edited(change)


def test_hq_builds_a_media_map_holding_no_path_as_an_empty_one(rule_documents, hq, core_runner):
    with published(rule_documents[DOCUMENT], core_runner) as app:
        nova = app.spell()
        saved = app.spell(doc=edited(_blank_everywhere))
        path_alone = app.spell(doc=_beside_a_path(blank=False))
        beside_blank = app.spell(doc=_beside_a_path(blank=True))

    assert_spelled(nova, saved, RULE, lambda path: path.rsplit("/", 2)[-2] in MEDIA)
    assert_same_build(nova, saved)
    # HQ's fallback finds the path where the app's language has no entry, and the blank where it has one.
    for spelled in (path_alone, beside_blank):
        assert spelled.build.files is not None and not spelled.build.raised, spelled.build.raised
    assert shown(build_differences(path_alone.build, beside_blank.build, rules=(RULE,)))
    assert shown(stored_differences(path_alone.stored, beside_blank.stored, rules=(RULE,)))
