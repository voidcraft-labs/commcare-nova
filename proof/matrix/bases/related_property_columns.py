"""Native case list columns saved on HQ's Case List and Case Detail pages."""
from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base


def question_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    form.new_question("site_name", "Site name", "string")
    return form.tostring(xml_declaration=True).decode("utf-8")


def build(authoring):
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Site roster")
    _pages.new_case_module(authoring, app_id, name="Sites", case_type="site")
    ops.upload_form_source(authoring, app_id, 0, 0, question_source, "new-site")
    _pages.save_case_actions(authoring, app_id, 0, 0, name_path="/data/site_name")
    ops.upload_form_source(authoring, app_id, 0, 1, question_source, "visit-site")
    columns = [
        _pages.column("name", "Site"),
        _pages.column("historic-site/site_status", "Related site status"),
        _pages.column("x" * 256, "Archived note"),
    ]
    _pages.save_case_list(authoring, app_id, 0, columns=columns)
    _pages.save_case_detail(authoring, app_id, 0, columns=columns)
    return app_id


BASE = Base(
    id="hq-related-property-columns",
    build=build,
    configuration=Configuration(),
    exhibits=(
        "menus-and-case-lists/idx-prop-in-a-menu-that-offers-search-or-through-an-index",
        "menus-and-case-lists/column-reading-a-property-name-over-255-characters",
    ),
    vellum=((0, 0), (0, 1)),
)
