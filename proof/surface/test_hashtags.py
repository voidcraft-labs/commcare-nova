"""The hashtags HQ defines.

Contracts and the failures they catch:
- Each shortcut the family records ``interpolate_xpath`` replacing is one HQ's
  own ``interpolate_xpath`` replaces when its condition holds (run here with a
  case and a lookup value in scope, the output holding none of them), and
  each it records ``_ensure_no_case_references`` refusing is one HQ refuses
  with no case in scope while an ``#user`` read passes.
- The ``#form/`` item says what HQ's own ``XForm.hashtag_path`` does to a
  question's path (``/data/q`` becomes ``#form/q``), and the related-case
  hashtags are composed from ``_get_case_schema_subsets``'s own generation
  names.
- Each hashtag the family records in a substring list decides what HQ's own
  checks do with an expression holding it: ``xpath_references_case`` is true
  for each case one and false for each usercase one, which
  ``xpath_references_usercase`` finds; an expression holding neither is
  neither. The readers include those checks and their callers in HQ's build
  (``menus.py``) and validators.
- A shortcut planted in a temporary copy of ``xpath.py``'s replacements table,
  a hashtag planted in a temporary copy of a schema module, and a hashtag and
  a reader planted in a temporary copy of ``util.py``'s substring list are
  read; the unplanted surface has none of them.
"""

from __future__ import annotations

import dataclasses

import pytest

from proof.surface.families.hashtags import (
    INTERPOLATE,
    SCHEMAS,
    SUBSTRING_LISTS,
    interpolations,
    schema_hashtags,
    substring_lists,
)


def test_shortcuts_are_what_hq_replaces_and_refuses(items, hq):
    from corehq.apps.app_manager.exceptions import CaseXPathValidationError
    from corehq.apps.app_manager.xpath import interpolate_xpath

    replaced = [
        key.split(":", 1)[1] for key, facts in items.items() if key.startswith("hashtag:") and "replacedBy" in facts
    ]
    assert set(replaced) >= {"#case", "#parent", "#host", "#user", "#session/", "$fixture_value"}
    expression = " and ".join(f"{shortcut}x = 1" for shortcut in sorted(replaced))
    result = interpolate_xpath(expression, case_xpath="current()/case", fixture_xpath="instance('t')/v")
    for shortcut in replaced:
        assert shortcut not in result, (shortcut, result)
    refused = [
        key.split(":", 1)[1]
        for key, facts in items.items()
        if key.startswith("hashtag:") and "refusedWithoutCase" in facts
    ]
    assert set(refused) == {"#case", "#parent", "#host"}
    for shortcut in refused:
        with pytest.raises(CaseXPathValidationError):
            interpolate_xpath(f"{shortcut}/p = 1", interpolate_dots=False)
    assert interpolate_xpath("#user/p = 1", interpolate_dots=False)


def test_form_paths_and_related_cases(items, hq):
    from corehq.apps.app_manager.xform import XForm

    replacing = [
        key.split(":", 1)[1] for key, facts in items.items() if key.startswith("hashtag:") and "replaces" in facts
    ]
    assert replacing == ["#form/"]
    assert XForm("").hashtag_path("/data/group/q") == "#form/group/q"
    for base in ("#case/", "#registry_case/"):
        assert f"hashtag:{base}parent" in items and f"hashtag:{base}grandparent" in items


def test_substring_hashtags_decide_hqs_case_checks(items, hq):
    from corehq.apps.app_manager.util import xpath_references_case, xpath_references_usercase

    lists: dict[str, list[str]] = {}
    for key, facts in items.items():
        for read in facts.get("substringOf", []) if key.startswith("hashtag:") else []:
            lists.setdefault(read["list"], []).append(key.split(":", 1)[1])
            readers = {reader["at"].rsplit("::", 1)[1] for reader in read["readBy"]}
            called = {caller for reader in read["readBy"] for caller in reader.get("calledBy", [])}
            assert {"xpath_references_case", "get_form_view_context"} <= readers, key
            assert any("suite_xml/sections/menus.py" in caller for caller in called), key
    assert set(lists["CASE_XPATH_SUBSTRING_MATCHES"]) == {"#case", "#parent", "#host"}
    assert lists["USERCASE_XPATH_SUBSTRING_MATCHES"] == ["#user"]
    for hashtag in lists["CASE_XPATH_SUBSTRING_MATCHES"]:
        assert xpath_references_case(f"{hashtag}/p = 1"), hashtag
    for hashtag in lists["USERCASE_XPATH_SUBSTRING_MATCHES"]:
        assert xpath_references_usercase(f"{hashtag}/p = 1") and not xpath_references_case(f"{hashtag}/p = 1")
    assert not xpath_references_case("/data/p = 1") and not xpath_references_usercase("/data/p = 1")


def test_planted_hashtags_are_read(plant, sources, items):
    interpolate, schema, util = INTERPOLATE[0], SCHEMAS[1], SUBSTRING_LISTS[0]
    root = plant(
        sources.hq,
        [interpolate, schema, util],
        {
            interpolate: (
                "    if fixture_xpath:\n",
                "    replacements['#planted'] = 'planted()'\n    if fixture_xpath:\n",
            ),
            schema: ('"hashtag": "#user",', '"hashtag": "#planted_user",'),
            util: (
                '    "#host",\n]\n',
                '    "#host",\n    "#planted_case",\n]\n\n\ndef planted_reader(xpath):\n'
                "    return CASE_XPATH_SUBSTRING_MATCHES[0] in xpath\n",
            ),
        },
    )
    planted = dataclasses.replace(sources, hq=root)
    assert "#planted" in interpolations(planted, root / interpolate)
    assert "hashtag:#planted" not in items
    assert "#planted_user" in {hashtag for hashtag, _, _ in schema_hashtags(planted, root / schema)}
    assert "hashtag:#planted_user" not in items
    substring = {hashtag: read for hashtag, _, read in substring_lists(planted, root / util)}
    assert "#planted_case" in substring and "hashtag:#planted_case" not in items
    unplanted = [reader["at"] for read in items["hashtag:#case"]["substringOf"] for reader in read["readBy"]]
    assert unplanted and not [at for at in unplanted if "planted_reader" in at]
    assert any(reader["at"].endswith("util.py::planted_reader") for reader in substring["#case"]["readBy"])
