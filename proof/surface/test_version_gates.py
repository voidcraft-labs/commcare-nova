"""Build-version gates.

Contracts and the failures they catch:
- Each ``feature_support.py`` property records its minimum versions in the
  order HQ compares them (``LooseVersion``). A property planted with
  ``2.57`` and ``2.9`` records ``['2.9', '2.57']``: a string or float order,
  or source order, gives ``['2.57', '2.9']``.
- The minimums agree with an independent reading of every
  ``_require_minimum_version`` argument in the file, and the highest of them
  is 2.57 (m13's reading at the pin, and the version the harness builds at).
- A direct comparison records only literal versions: the dictionary key in
  ``LooseVersion(yaml_setting.get('since', '0'))`` is not a version, and the
  expression it compares with is recorded as one.
- A planted property, template element and direct comparison in temporary
  copies are each read; the unplanted sources are not.
"""

from __future__ import annotations

import ast
import dataclasses

from looseversion import LooseVersion

from proof.surface.families.version_gates import (
    FEATURE_SUPPORT,
    SCRIPTS,
    direct_comparisons,
    feature_support,
    script_gates,
    template_gates,
)


def _minimums_in(path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [
        node.args[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "_require_minimum_version"
        and node.args
        and isinstance(node.args[0], ast.Constant)
    ]


def test_the_minimums_are_those_hq_requires(items, sources):
    minimums = [
        version
        for key, facts in items.items()
        if key.startswith("version-gate:") and "minimum" in facts
        for version in facts["minimum"]
    ]
    independent = _minimums_in(sources.hq / FEATURE_SUPPORT)
    assert sorted(set(minimums), key=LooseVersion) == sorted(set(independent), key=LooseVersion)
    assert max(independent, key=LooseVersion) == "2.57"


def test_a_propertys_minimums_are_in_hqs_order(plant, sources):
    root = plant(
        sources.hq,
        [FEATURE_SUPPORT],
        {
            FEATURE_SUPPORT: (
                "    @property\n    def enable_multi_sort(self):",
                "    @property\n    def planted_two_minimums(self):\n"
                "        return self._require_minimum_version('2.57') or self._require_minimum_version('2.9')\n\n"
                "    @property\n    def enable_multi_sort(self):",
            )
        },
    )
    planted = dataclasses.replace(sources, hq=root)
    gates = {i.key: i.facts for i in feature_support(planted, root / FEATURE_SUPPORT)}
    assert gates["version-gate:planted_two_minimums"]["minimum"] == ["2.9", "2.57"]


def test_direct_comparisons_record_literal_versions_only(items):
    profile = items["version-gate:corehq/apps/app_manager/models/applications.py::Application.get_profile_setting"]
    assert profile["versions"] == []
    assert profile["versionExpressions"] == ["yaml_setting.get('since', '0')"]
    vellum = items["version-gate:corehq/apps/app_manager/views/formdesigner.py::_get_vellum_features"]
    assert vellum["versions"] == ["2.55"] and vellum["versionExpressions"] == []


def test_toggle_conjuncts_and_templates(items):
    assert items["version-gate:supports_session_endpoints"]["toggles"] == ["SESSION_ENDPOINTS"]
    assert items["version-gate:enable_case_list_icon_dynamic_width"]["minimum"] == []
    template = items["version-gate:corehq/apps/app_manager/templates/app_manager/partials/forms/form_gps_capture.html"]
    assert template["elements"] == [{"id": "auto-gps-capture", "since": "2.14", "tag": "div"}]


def test_planted_gates_are_read(plant, sources):
    template = "corehq/apps/app_manager/templates/app_manager/partials/forms/form_gps_capture.html"
    views = "corehq/apps/app_manager/views/formdesigner.py"
    root = plant(
        sources.hq,
        [FEATURE_SUPPORT, template, views],
        {
            FEATURE_SUPPORT: (
                "    @property\n    def enable_multi_sort(self):",
                "    @property\n    def planted_gate(self):\n"
                "        return self._require_minimum_version('2.99') and toggles.PLANTED.enabled(self.domain)\n\n"
                "    @property\n    def enable_multi_sort(self):",
            ),
            template: (
                'data-since-version="2.14">',
                'data-since-version="2.14"><span data-since-version="2.98"></span>',
            ),
            views: (
                "def _get_vellum_features(request, domain, app):",
                "def planted_view(app):\n    return app.build_version < LooseVersion('2.97')\n\n\n"
                "def planted_other(app):\n    return app.build_version < other_version('2.96')\n\n\n"
                "def _get_vellum_features(request, domain, app):",
            ),
        },
    )
    planted = dataclasses.replace(sources, hq=root)
    gates = {i.key: i.facts for i in feature_support(planted, root / FEATURE_SUPPORT)}
    assert gates["version-gate:planted_gate"]["minimum"] == ["2.99"]
    assert gates["version-gate:planted_gate"]["toggles"] == ["PLANTED"]
    elements = template_gates(planted, root / "corehq/apps/app_manager/templates")[0].facts["elements"]
    assert [element["since"] for element in elements] == ["2.14", "2.98"]
    compared = {i.key.split("::")[-1]: i.facts for i in direct_comparisons(planted, root / "corehq/apps/app_manager")}
    assert compared["planted_view"]["versions"] == ["2.97"]
    # A literal passed to anything but the LooseVersion the file imports is not a version HQ compares with.
    assert compared["planted_other"]["versions"] == []
    assert compared["planted_other"]["versionExpressions"] == ["other_version('2.96')"]
    assert "version-gate:planted_gate" not in {i.key for i in feature_support(sources, sources.hq / FEATURE_SUPPORT)}


def test_the_script_pass_reads_a_planted_setting_field(plant, sources):
    settings_script = SCRIPTS[3]
    root = plant(
        sources.hq,
        [settings_script],
        {
            settings_script: (
                "        setting.inputId = setting.id + '-input';",
                "        setting.inputId = setting.id + '-input' + setting.planted_since_field;",
            )
        },
    )
    planted = dataclasses.replace(sources, hq=root)
    (read,) = script_gates(planted, [root / settings_script])
    fields = next(reader["fields"] for reader in read.facts["readers"] if "fields" in reader)
    assert "planted_since_field" in fields and "since" in fields
    (unplanted,) = script_gates(sources, [sources.hq / settings_script])
    assert "planted_since_field" not in next(r["fields"] for r in unplanted.facts["readers"] if "fields" in r)
