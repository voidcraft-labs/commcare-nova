"""UI string ids, target-derived profile properties, and lookup upload constants.

Contracts and the failures they catch:
- Every id in Android's catalog is a ``ui-string`` item naming that catalog
  (the test reads the file itself, line by line: an id is the text before the
  first ``=`` of a line that is not a comment). Every id HQ's own loader
  (``commcare_translations.load_translations``) returns for an app's language
  and build version is an item that says so, exactly: at CommCare 2.54.0 (the
  version Nova's shell names, which HQ reads from its historical catalog) the
  ids whose ``hqBuildVersions`` reach 2.54 are the loader's, and for Hindi,
  Swahili, Portuguese (``pt``) and English with no build version, and the
  ``dump-known`` strategy's version 1, the ids naming that catalog are the
  loader's. A family that read only the current English catalog fails.
- A read reaches its id through a helper: a constant passed to
  ``MarkupUtil.localizeStyleSpannable`` (whose parameter reaches
  ``Localization.get``) in a temporary copy of an Android class, and a Kotlin
  ``Localization.get`` of a constant, are read by Android; neither is in the
  unplanted surface. The reviewer's examples hold: ``form.record.gone`` (through
  that helper), ``home.forms.incomplete`` (through ``CommCareActivity.localize``
  on a class whose hierarchy passes through a Kotlin class), ``profile.found``
  (Kotlin) and the ``android.package.name.*`` pattern.
- Every constant ``<property>`` HQ's own template renderer writes into a
  profile (``render_to_string('app_manager/profile.xml', ...)`` with every
  condition true, its output parsed with lxml) is a ``profile-property`` item,
  and one under ``{% if %}`` records that condition; a property planted in a
  temporary copy of the template is read with its condition. Each property's
  ``force`` is spelled as the renderer writes it: for a property
  ``create_profile`` adds, HQ's renderer given the force the item records
  writes the item's ``force`` back (``"true"``, or no attribute), never
  Python's ``True``.
- ``MAX_FIXTURE_ROWS`` holds the value HQ's loaded constant has, read by the
  workbook reader, and a planted value in a temporary copy is the item's.
"""

from __future__ import annotations

import dataclasses
from types import SimpleNamespace
from urllib.parse import unquote

from lxml import etree

from proof.surface.families.data import _constant_item
from proof.surface.families.profile import TEMPLATE, template_properties
from proof.surface.families.strings import ui_strings

ANDROID_CATALOG = "app/assets/locales/android_translatable_strings.txt"
WIDE_CORE = (
    "src/main/java/org/javarosa/form/api",
    "src/main/java/org/javarosa/xform/parse/XFormParser.java",
    "src/cli/java/org/commcare/util/screen/ScreenUtils.java",
)


def _catalog_ids(path) -> set[str]:
    """The ids of a catalog's lines that hold a value: the text before the first `=`, after dropping a comment
    (a `#` no backslash escapes)."""
    ids = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        kept = ""
        for index, character in enumerate(line):
            if character == "#" and (index == 0 or line[index - 1] != "\\"):
                break
            kept += character
        identifier, equals, value = kept.strip().partition("=")
        if equals and value:
            ids.add(identifier)
    return ids


def test_every_android_catalog_id_is_an_item(items, sources):
    android = _catalog_ids(sources.android / ANDROID_CATALOG)
    assert android
    for identifier in android:
        assert f"commcare-android/{ANDROID_CATALOG}" in items[f"ui-string:{identifier}"]["catalogs"], identifier


def _reaches(runs: list[str], version: str) -> bool:
    from packaging.version import Version

    for run in runs:
        first, _, last = run.partition("..")
        if Version(first) <= Version(version) <= Version(last or first):
            return True
    return False


def test_every_id_hqs_loader_emits_is_an_item_that_says_so(items, hq):
    from commcare_translations import load_translations

    # A key's name percent-encodes what is not printable ASCII: HQ's Hindi catalog opens with a byte order mark,
    # which its loader keeps on the first id.
    strings = {unquote(key.split(":", 1)[1]): facts for key, facts in items.items() if key.startswith("ui-string:")}
    # Nova's shell names CommCare 2.54.0, which HQ reads from the 2.54 historical catalog.
    loaded = set(load_translations("en", version=2, commcare_version="2.54.0"))
    claimed = {i for i, facts in strings.items() if _reaches(facts.get("hqBuildVersions", []), "2.54")}
    assert loaded and loaded == claimed
    for language, version, build, catalog in (
        ("en", 2, None, "messages_en-2.txt"),
        ("en", 1, None, "messages_en-1.txt"),
        ("hin", 2, "2.54.0", "messages_hin-1.txt"),
        ("sw", 2, None, "messages_sw-1.txt"),
        ("pt", 2, None, "messages_por-1.txt"),
    ):
        loaded = set(load_translations(language, version=version, commcare_version=build))
        where = f"commcare-hq/submodules/commcare-translations/{catalog}"
        claimed = {i for i, facts in strings.items() if where in facts.get("catalogs", [])}
        assert loaded and loaded == claimed, (language, version, build)


def test_reads_reach_their_ids_through_helpers(plant, sources, items):
    for identifier in ("form.record.gone", "home.forms.incomplete", "profile.found"):
        assert "android" in items[f"ui-string:{identifier}"]["readBy"], identifier
    assert items["ui-string:android.package.name.*"]["pattern"] is True
    record_view = "app/src/org/commcare/views/IncompleteFormRecordView.java"
    anchor = 'MarkupUtil.localizeStyleSpannable(getContext(), "form.record.gone")'
    kotlin = "app/src/org/commcare/utils/ApkDependenciesUtils.kt"
    kotlin_anchor = 'return Localization.get("android.package.name.${androidPackageDependency.id}")'
    android = plant(
        sources.android,
        [record_view, "app/src/org/commcare/utils/MarkupUtil.java", kotlin, "app/assets/locales"],
        {
            record_view: (anchor, 'MarkupUtil.localizeStyleSpannable(getContext(), "planted.helper.string")'),
            kotlin: (kotlin_anchor, 'return Localization.get("planted.kotlin.string")'),
        },
    )
    core = plant(sources.core, list(WIDE_CORE), {})
    planted = {one.key: one.facts for one in ui_strings(sources, core, android)}
    for identifier in ("planted.helper.string", "planted.kotlin.string"):
        assert planted[f"ui-string:{identifier}"]["readBy"] == ["android"], identifier
        assert f"ui-string:{identifier}" not in items


def test_constant_profile_properties_are_what_hqs_renderer_writes(items, hq):
    from django.template.loader import render_to_string

    app = SimpleNamespace(
        version=3,
        build_spec=SimpleNamespace(major_release="2", minor_release="57", patch_release="0"),
        ota_restore_url="o",
        post_url="p",
        key_server_url="k",
        persistent_menu=False,
        show_breadcrumbs=True,
        enable_relative_suite_path=True,
        suite_loc="s",
        suite_url="u",
    )
    rendered = render_to_string(
        "app_manager/profile.xml",
        {
            "app": app,
            "app_profile": {"properties": {}, "features": {}},
            "apk_heartbeat_url": "h",
            "target_package_id": "t",
            "support_email": "e",
            "locale": "en",
        },
    )
    written = {element.get("key") for element in etree.fromstring(rendered.encode("utf-8")).iter("property")}
    from_template = {
        key.split(":", 1)[1]
        for key, facts in items.items()
        if key.startswith("profile-property:")
        and f"commcare-hq/{TEMPLATE}" in facts["source"]
        and not facts.get("authored")
    }
    assert written == from_template
    assert items["profile-property:heartbeat-url"]["written"][0]["when"] == ["if apk_heartbeat_url"]
    assert items["profile-property:recovery-measures-url"]["written"][0]["when"] == [
        "toggles.MOBILE_RECOVERY_MEASURES.enabled(self.domain)"
    ]
    for element in etree.fromstring(rendered.encode("utf-8")).iter("property"):
        assert items[f"profile-property:{element.get('key')}"]["written"][0].get("force") == element.get("force")
    created = {
        key.split(":", 1)[1]: written
        for key, facts in items.items()
        if key.startswith("profile-property:") and not facts.get("authored")
        for written in facts["written"]
        if "create_profile" in " ".join(facts["source"]) and f"commcare-hq/{TEMPLATE}" not in facts["source"]
    }
    assert created
    with_created = render_to_string(
        "app_manager/profile.xml",
        {
            "app": app,
            "app_profile": {
                "properties": {
                    key: {"value": "v", "force": written.get("force") == "true"} for key, written in created.items()
                },
                "features": {},
            },
            "locale": "en",
        },
    )
    for element in etree.fromstring(with_created.encode("utf-8")).iter("property"):
        if element.get("key") in created:
            assert created[element.get("key")].get("force") == element.get("force"), element.get("key")


def test_a_planted_profile_property_is_read(plant, sources, items):
    root = plant(
        sources.hq,
        [TEMPLATE],
        {
            TEMPLATE: (
                "    {% if support_email %}\n",
                '    {% if planted_flag %}\n    <property key="planted-property" value="{{ planted }}" force="true"/>\n'
                "    {% endif %}\n    {% if support_email %}\n",
            )
        },
    )
    planted = dict(template_properties(dataclasses.replace(sources, hq=root), root / TEMPLATE))
    assert planted["planted-property"]["when"] == ["if planted_flag"]
    assert planted["planted-property"]["value"] == "{{ planted }}"
    assert "profile-property:planted-property" not in items


def test_upload_constants_hold_hqs_values(items, plant, sources, hq):
    from corehq.apps.fixtures.upload.const import MAX_FIXTURE_ROWS

    key = "lookup-code:corehq/apps/fixtures/upload/const.py::MAX_FIXTURE_ROWS"
    assert items[key]["value"] == MAX_FIXTURE_ROWS
    assert "commcare-hq/corehq/apps/fixtures/upload/workbook.py::_FixtureWorkbook.__init__" in items[key]["readBy"]
    const = "corehq/apps/fixtures/upload/const.py"
    root = plant(sources.hq, ["corehq/apps/fixtures/upload"], {const: ("500_000", "123")})
    planted = _constant_item(
        "lookup-code", dataclasses.replace(sources, hq=root), const, "MAX_FIXTURE_ROWS", "corehq/apps/fixtures/upload"
    )
    assert planted.facts["value"] == 123
    assert "delete_missing=False" in " ".join(
        items["lookup-code:corehq/apps/fixtures/upload/run_upload.py::_run_upload"]["calls"]
    )
