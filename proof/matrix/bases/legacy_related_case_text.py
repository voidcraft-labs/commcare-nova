"""HQ retains legacy wording selected from a related record on the case list.

The current editor offers Translatable Text on calculations. HQ still reads
the older property-backed column through the import API, and generates its
header and wording under keys named for the relationship path.
"""

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.case_lists import _column, save_list
from proof.matrix.bases.search import one_question_source
from proof.matrix.registry import Base


def build(authoring) -> str:
    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Related case wording")
    _pages.new_case_module(authoring, app_id, name="Patients", case_type="patient")
    _pages.delete_form(authoring, app_id, 0, 0)
    ops.upload_form_source(authoring, app_id, 0, 0, one_question_source("note", "Visit note"), "visit")
    save_list(authoring, app_id, 0, columns=[_column("name", "Name")], sort_elements=[])

    legacy = _column(
        "parent/village", "Parent village", format="translatable-enum",
        enum=[{"doc_type": "MappingItem", "key": "north", "value": {"en": "North village"}, "alt_text": {}}],
    )
    ops.set_json(authoring, app_id, "/modules/0/case_details/short/columns/-", legacy)
    with authoring.step("native-legacy-related-wording"):
        app = operations.held_app(authoring.state, app_id)
        strings = parse_app_strings(app.create_app_strings("en"))
        assert strings["m0.case_short.case_parent/village_2.header"] == "Parent village"
        assert strings["m0.case_short.case_parent/village_2.enum.knorth"] == "North village"
    return app_id


BASE = Base(
    id="hq-legacy-related-case-text",
    build=build,
    configuration=Configuration(),
    exhibits=("menus-and-case-lists/translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-does",),
)
