"""The case search request keys and the search prompt vocabulary.

Contracts and the failures they catch:
- Every key the family gives the ``configuration`` role is one HQ's own
  ``extract_search_request_config`` takes out of a request as configuration,
  and a key it does not name stays a criterion to match; every key
  ``_apply_filter`` tests is an item with the filter role, in order. A branch
  planted in a temporary copy of ``case_search/utils.py`` is read.
- Every prompt input or appearance HQ's own editor save
  (``views/modules.py::_update_search_properties``, run here on each editor
  appearance) stores is an item HQ writes; a value only an ``else`` branch
  excludes is not credited to it (``address`` is never an input HQ's editor
  stores). The runtimes' readings name the values Core, Android (Java and
  Kotlin) and Web Apps (script and Underscore template) compare. A comparison
  planted in a temporary copy of Web Apps' ``query.js`` and one planted in an
  Underscore template are read.
"""

from __future__ import annotations

import dataclasses
import json

from proof.surface.families.search import QUERY_SCRIPT, QUERY_TEMPLATES, request_keys, web_apps

UTILS = "corehq/apps/case_search/utils.py"


def test_configuration_keys_are_what_hqs_request_reader_takes(items, hq):
    from corehq.apps.case_search.models import extract_search_request_config

    configuration = [
        key.split(":", 1)[1]
        for key, facts in items.items()
        if key.startswith("csql-key:") and "configuration" in facts["roles"]
    ]
    assert configuration
    for key in configuration:
        config = extract_search_request_config({"case_type": "person", key: "a-value", "planted_property": "x"})
        criteria = {criterion.key for criterion in config.criteria}
        assert key not in criteria, key
        assert criteria == {"planted_property"}, (key, criteria)
    assert "csql-key:planted_property" not in items
    filters = sorted(
        (facts["filterOrder"], key.split(":", 1)[1])
        for key, facts in items.items()
        if key.startswith("csql-key:") and "filterOrder" in facts
    )
    assert [key for _, key in filters][:3] == ["_xpath_query", "case_id", "owner_id"]


def test_a_planted_filter_branch_is_read(plant, sources, hq, items):
    root = plant(
        sources.hq,
        [UTILS],
        {
            UTILS: (
                "        elif criteria.key == 'case_id':\n",
                "        elif criteria.key == 'planted_key':\n"
                "            return search_es.filter(case_es.case_ids(criteria.value))\n"
                "        elif criteria.key == 'case_id':\n",
            )
        },
    )
    planted = {one.key: one.facts for one in request_keys(dataclasses.replace(sources, hq=root))}
    assert planted["csql-key:planted_key"]["filterOrder"] == 2
    assert planted["csql-key:case_id"]["filterOrder"] == 3
    assert "csql-key:planted_key" not in items


def _stored_by_hqs_editor(hq) -> set[tuple[str, str]]:
    from corehq.apps.app_manager.models import Module
    from corehq.apps.app_manager.views.modules import _update_search_properties

    fixture = json.dumps({"instance_id": "t", "nodeset": "n", "label": "l", "value": "v", "sort": "s"})
    stored = set()
    for appearance in ("", "fixture", "checkbox", "barcode_scan", "address", "date", "daterange"):
        for multiselect in (False, True):
            prop = {
                "name": "p",
                "label": "P",
                "appearance": appearance,
                "fixture": fixture,
                "is_multiselect": multiselect,
                "default_value": "d",
            }
            for saved in _update_search_properties(Module.wrap({"doc_type": "Module"}), [prop]):
                for field in ("input_", "appearance"):
                    if field in saved:
                        stored.add((field, saved[field]))
    return stored


def test_prompt_values_hqs_editor_stores_are_items(items, hq):
    stored = _stored_by_hqs_editor(hq)
    assert stored
    credited = set()
    for key, facts in items.items():
        if not key.startswith(("prompt-input:", "prompt-appearance:")):
            continue
        for read in facts["reads"]:
            if read["reader"] == "hq" and read["at"].endswith("::_update_search_properties"):
                field = "input_" if key.startswith("prompt-input:") else "appearance"
                credited.add((field, key.split(":", 1)[1]))
    assert credited == stored
    assert ("input_", "address") not in credited
    readers = {read["reader"] for read in items["prompt-input:daterange"]["reads"]}
    assert {"core", "android", "cli", "web-apps", "hq"} <= readers
    assert {read["reader"] for read in items["prompt-appearance:barcode_scan"]["reads"]} >= {"android", "hq"}


def test_planted_web_apps_comparisons_are_read(plant, sources, items):
    template = f"{QUERY_TEMPLATES}/item.html"
    root = plant(
        sources.hq,
        [QUERY_SCRIPT, QUERY_TEMPLATES],
        {
            QUERY_SCRIPT: (
                "        if (this.model.get('input') === 'address') {\n            return;",
                "        if (this.model.get('input') === 'planted-script-input') {\n            return;\n        }\n"
                "        if (this.model.get('input') === 'address') {\n            return;",
            ),
            template: (
                '<% } else if (input == "address") { %>',
                '<% } else if (input == "planted-template-input") { %>\n<% } else if (input == "address") { %>',
            ),
        },
    )
    planted_sources = dataclasses.replace(sources, hq=root)
    values = {read["value"] for read in web_apps(planted_sources, root / QUERY_SCRIPT, root / QUERY_TEMPLATES)}
    assert {"planted-script-input", "planted-template-input"} <= values
    assert not {"prompt-input:planted-script-input", "prompt-input:planted-template-input"} & set(items)
