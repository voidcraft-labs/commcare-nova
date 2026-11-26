"""An old heading key still emitted by HQ's search suite and Translation workbook."""

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.case_lists import _column, save_list
from proof.matrix.bases.search import field, one_question_source, save_search
from proof.matrix.registry import Base


def build(authoring) -> str:
    from lxml import etree

    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Client Search wording")
    _pages.new_case_module(authoring, app_id, name="Clients", case_type="client")
    _pages.delete_form(authoring, app_id, 0, 0)
    ops.upload_form_source(authoring, app_id, 0, 0, one_question_source("note", "Visit note"), "visit")
    save_list(authoring, app_id, 0, columns=[_column("name", "Name")], sort_elements=[])
    group, ordinary, translated = "g", "Personal details", "Find a client"
    save_search(authoring, app_id, 0, fields=[
        field(group, ordinary, is_group=True, group_key=group),
        field("name", "Client name", group_key=group),
    ], auto_launch=True)

    key = f"search_property.m0.{group}"
    with authoring.step("build:upload-search-heading-wording"):
        ops.upload_commcare_translation(authoring.state, app_id, key, translated)
    with authoring.step("native-legacy-search-heading"):
        app = operations.held_app(authoring.state, app_id)
        assert app.get_module(0).search_config.properties[0].label == {"en": ordinary}
        assert app.translations["en"][key] == translated
        assert parse_app_strings(app.create_app_strings("en"))[key] == translated
        assert etree.fromstring(app.create_suite()).xpath(f"//group[@key='{group}']/display/text/locale[@id='{key}']")
    return app_id


BASE = Base(
    id="hq-legacy-search-group-wording",
    build=build,
    configuration=Configuration(flags=frozenset({"SYNC_SEARCH_CASE_CLAIM", "CASE_SEARCH_ADVANCED"}),
                                case_search_enabled=True),
    exhibits=(
        "application-and-settings/translations-generated-wording",
        "case-search/is-group-group-key",
    ),
)
