"""``hq-lookup-types``: an app made in HQ whose form reads a lookup table tagged ``types``.

HQ's table page saves a table under the tag ``types`` (``fixtures/views.py::update_tables`` checks only that
``<tag>_list`` is an XML identifier, ``fixtures/utils.py::is_identifier_invalid``, its length, and that no table of
the project space holds the tag), and HQ's restore serves its rows as
any other table's (``fixturegenerators.py::ItemListsProvider``), so a worker reads it from
``jr://fixture/item-list:types``. Only HQ's workbook cannot carry it: its reader spends the sheet ``types`` on its
own list of tables (``fixtures/upload/workbook.py::_FixtureWorkbook.get_types_sheet``).

1. A new app (``views/apps.py::default_new_app``), named "Visit log" on the app page (``edit_app_attr``), with
   Web Apps turned on, so it is read as running on both platforms.
2. Two global lookup tables made with HQ's own models (``fixtures/models.py::LookupTable``, ``LookupTableRow``), as
   HQ's table page saves them: ``types``, the kinds of visit, each with a description; and ``sites``, so the
   table under ``types`` stands beside an ordinary one.
3. A survey menu "Visit" (``views/modules.py::new_module``) whose one form's source is written by HQ's own form
   writer (``xform_builder.py::XFormBuilder``) and uploaded on the form page: a select ``visit_type`` whose
   choices are the rows of ``types``, a select ``site`` over ``sites``, and a hidden value ``visit_description``
   that reads the chosen type's description from ``types``.

Its configuration is the lane's floor with ``LOOKUP_TABLES``, which a form that reads a table needs
(``helpers/validators.py::ApplicationValidator._validate_fixtures``), and ``CLOUDCARE`` for Web Apps.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.lookups import declare_instance, lookup_select, make_tables
from proof.matrix.registry import Base

NAME = "Visit log"
MENU = "Visit"
TAG = "types"

TABLES = (
    {
        "tag": TAG,
        "fields": ("id", "name", "description"),
        "rows": (
            ("first", "First visit", "Meet the family"),
            ("follow_up", "Follow-up", "Check on progress"),
            ("closing", "Closing visit", "Say goodbye"),
        ),
    },
    {
        "tag": "sites",
        "fields": ("id", "name"),
        "rows": (("home", "At home"), ("clinic", "At the clinic")),
    },
)


def visit_source(name):
    """The visit form, as HQ's ``XFormBuilder`` writes it, with its selects over ``types`` and ``sites``."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    lookup_select(xform, "visit_type", "Visit type", TAG)
    lookup_select(xform, "site", "Where", "sites")
    xform.new_question(
        "visit_description",
        None,
        None,
        calculate=f"instance('item-list:{TAG}')/{TAG}_list/{TAG}[id = /data/visit_type]/description",
    )
    declare_instance(xform, f"item-list:{TAG}", f"jr://fixture/item-list:{TAG}")
    declare_instance(xform, "item-list:sites", "jr://fixture/item-list:sites")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)
    make_tables(authoring, TABLES)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    ops.upload_form_source(authoring, app_id, 0, 0, visit_source, "visit-source")
    return app_id


BASE = Base(
    id="hq-lookup-types",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "LOOKUP_TABLES"})),
    exhibits=("expressions-and-data/tag-types",),
)
