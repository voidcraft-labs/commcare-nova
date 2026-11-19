"""The lane's reading of who owns a key of an app's ``translations`` is Nova's (``proof.checks.compare.app_strings``).

Contract: ``translation_key_owner`` answers every row of ``fixtures/translation-key-owners.json`` as Nova's
``lib/commcare/appStringKeys.ts::translationKeyOwner`` does (``lib/commcare/__tests__/appStringKeys.test.ts`` holds
Nova's to the same rows), judging a key as HQ's build writes it, stripped (``commcare_translations.dumps``), with a
fourth owner, ``not-its-own``, for a key that is no locale record of its own name; and ``is_locale_file_key`` and
``is_locale_file_value`` admit exactly what ``lib/commcare/localeFile.ts`` admits. The plausible failures: a mirror
that judges the key as stored, so `` modules.m0`` reads as the target's and the manifest check takes Nova's own text
for what it carries back; one that has no fourth owner, so a key holding ``=`` or a line break reads as the target's;
and one whose family match is anchored at both ends, so ``modules.m0.extra`` reads as the target's where HQ's
``re.match`` generates it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from proof.checks.compare.app_strings import (
    is_locale_file_key,
    is_locale_file_value,
    translation_key_owner,
    written_key,
)

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "translation-key-owners.json").read_text(encoding="utf-8"))


def _vector_id(vector) -> str:
    """A row's id: its owner and its key, every character outside printable ASCII, a space and a backslash written
    as ``<U+XXXX>``. pytest keeps a parametrization's ids on its mark and escapes them again when one process
    collects twice (the lane's server, then each worker it forks), so an id holding a backslash or a character
    pytest escapes would differ in the worker's collection (``proof/test_collection.py``)."""
    spelled = "".join(
        character if "!" <= character <= "~" and character != "\\" else f"<U+{ord(character):04X}>"
        for character in vector["key"]
    )
    return f"{vector['owner']}:{spelled}"


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=_vector_id)
def test_each_key_has_the_owner_novas_rule_gives_it(vector):
    assert translation_key_owner(vector["key"], frozenset(vector["codes"])) == vector["owner"]


def test_the_vectors_reach_every_owner():
    assert {vector["owner"] for vector in VECTORS["vectors"]} == {"generated", "language-name", "target", "not-its-own"}


def test_a_key_is_its_own_record_only_with_nothing_either_reader_moves():
    assert is_locale_file_key("home.start")
    assert is_locale_file_key("modules.m0")
    for key in ("", " home.start", "home.start ", " home.start", "home\u0001", "a=b", "a#b", "a\nb", "a\rb"):
        assert not is_locale_file_key(key), json.dumps(key)
    assert written_key(" modules.m0") == "modules.m0"
    assert written_key("x=y") is None
    assert written_key("\u0001home.start") is None


def test_a_value_is_one_record_unless_a_line_ends_in_it_or_it_spells_only_what_core_trims():
    for value in ("Begin", "Line one\nline two", "   ", "#1", "x=y\nmodules.m0"):
        assert is_locale_file_value(value), json.dumps(value)
    for value in ("Begin\rmodules.m0=Moved", "\r", "\u0001", "\u0001\u0002"):
        assert not is_locale_file_value(value), json.dumps(value)
