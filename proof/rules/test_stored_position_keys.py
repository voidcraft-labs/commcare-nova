"""HQ's build reads a stored ``m<N>_no_items_text`` and ``m<N>_select_text`` as it reads ``modules.m<N>``.

Contract: Nova's publish never carries a stored translation under a key HQ
generates (``lib/commcare/appStringKeys.ts::translationKeyOwner``), since a
generated key names a menu or a form by its position and a stored value
outranks the field that owns it: after a reorder it would name another. The
generated set is every pattern of ``id_strings.REGEXES``, not HQ's own
``is_custom_app_string``, whose expression HQ compiles from the patterns
registered before it. The plausible failure this test catches: a stored value
under the two patterns registered after that expression,
``m%d_no_items_text`` and ``m%d_select_text``, read by HQ's build otherwise
than ``modules.m%d`` (as a string a catalog key holds, kept whatever the
menu), so that carrying it would be safe and the two keys would be the
target's.

``case-list-inline`` is published under its maximum configuration, which
holds ``USH_EMPTY_CASE_LIST_TEXT``, so HQ's build writes the menu's
empty-list text and its select text. With a value stored under each of the
three keys for the app's first language, HQ's predicate answers false for
the two and true for ``modules.m0``, and the build writes each stored value
under its key in that language's strings and the default's, as it writes the
stored ``modules.m0``; with nothing stored, none of the three values is
written.

Nova judges a stored key as HQ's build writes it, stripped
(``commcare_translations.dumps`` writes ``key.strip()``), and a key that is no
locale record of its own name has a fourth owner, ``not-its-own``, which no
publish carries (``translationKeyOwner``; the lane's own reading is
``proof/checks/compare/app_strings.py::translation_key_owner``). The second
test holds that to HQ's build: a value stored under ``modules.m0 `` (a space
after it, so ``dumps``, which writes keys in order, writes its line after the
menu's own) is written as the menu's name, as one stored under
``modules.m0`` is, so the stripped key owns it and the lane's reading calls
it generated; a value stored under ``x=y`` is written as the string ``x``
holds, with ``y=`` before it, and one under a key holding a line break sets
the string the second line names, so neither key is its own. The plausible failure: a
build that writes a key as stored, so that only an exact generated key could
move a menu's name and a key holding ``=`` would be one string's own. Its
control is the same app with nothing stored, which writes neither.
"""

from __future__ import annotations

from proof.checks.compare.app_strings import parse_app_strings, translation_key_owner
from proof.rules.conftest import edited, published

DOCUMENT = "case-list-inline"
PLANTED = {"modules.m0": "Planted menu", "m0_no_items_text": "Planted empty", "m0_select_text": "Planted select"}


def _stored(doc):
    doc.setdefault("translations", {}).setdefault(doc["langs"][0], {}).update(PLANTED)


def test_hq_builds_a_stored_position_key_its_predicate_leaves_out_as_it_builds_modules(rule_documents, hq):
    from corehq.apps.app_manager.id_strings import is_custom_app_string

    assert [is_custom_app_string(key) for key in PLANTED] == [True, False, False]
    with published(rule_documents[DOCUMENT], None, configuration="maximum") as app:
        language = app.document.wire_languages[0]["code"]
        nova = app.spell()
        stored = app.spell(doc=edited(_stored))

    for spelled in (nova, stored):
        assert spelled.build.files is not None and not spelled.build.raised, spelled.build.raised
    for strings in (f"{language}/app_strings.txt", "default/app_strings.txt"):
        before = parse_app_strings(nova.build.files[strings])
        after = parse_app_strings(stored.build.files[strings])
        assert {key for key in PLANTED if before.get(key) == PLANTED[key]} == set(), strings
        assert {key: after.get(key) for key in PLANTED} == PLANTED, strings
        assert before["m0_no_items_text"] and before["m0_select_text"], strings


SMUGGLED = {"modules.m0 ": "Spaced menu", "x=y": "Planted x", "z=w\nm0_select_text": "Planted select"}


def _smuggled(doc):
    doc.setdefault("translations", {}).setdefault(doc["langs"][0], {}).update(SMUGGLED)


def test_hq_builds_a_stored_key_stripped_on_one_line_so_the_stripped_key_owns_it(rule_documents, hq):
    with published(rule_documents[DOCUMENT], None, configuration="maximum") as app:
        language = app.document.wire_languages[0]["code"]
        nova = app.spell()
        stored = app.spell(doc=edited(_smuggled))

    codes = frozenset({language})
    assert [translation_key_owner(key, codes) for key in SMUGGLED] == ["generated", "not-its-own", "not-its-own"]
    for spelled in (nova, stored):
        assert spelled.build.files is not None and not spelled.build.raised, spelled.build.raised
    for strings in (f"{language}/app_strings.txt", "default/app_strings.txt"):
        before = parse_app_strings(nova.build.files[strings])
        after = parse_app_strings(stored.build.files[strings])
        assert before.get("modules.m0") != "Spaced menu" and after.get("modules.m0") == "Spaced menu", strings
        assert "x" not in before and after.get("x") == "y=Planted x", strings
        assert before.get("m0_select_text") != "Planted select", strings
        assert after.get("m0_select_text") == "Planted select" and after.get("z") == "w", strings
        assert not {"modules.m0 ", "x=y"} & set(after), strings
