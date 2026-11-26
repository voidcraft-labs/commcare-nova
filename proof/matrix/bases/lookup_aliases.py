"""A visit form uses the worker's actual location alongside two lookup tables tagged
``locations`` and ``commcaresession``. Both tags coincide with instances the same form
reads. The HQ source uses the distinct form-local IDs Vellum permits for those fixtures.
The first table offers meeting sites and the second visit types. The saved visit type
also supplies its description through a lookup expression. Both worker platforms are on.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages, places
from proof.matrix.bases.lookups import declare_instance, lookup_select, make_tables
from proof.matrix.registry import Base

TABLES = (
    {
        "tag": "locations",
        "fields": ("id", "name"),
        "rows": (("school", "School yard"), ("clinic", "Health center")),
    },
    {
        "tag": "commcaresession",
        "fields": ("id", "name"),
        "rows": (("initial", "First visit"), ("follow_up", "Follow-up")),
    },
)


def visit_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    lookup_select(form, "meeting_site", "Meeting site", "locations", instance_id="locations-1")
    lookup_select(form, "visit_type", "Visit type", "commcaresession", instance_id="commcaresession-1")
    form.new_question("worker_village", None, None, calculate=f"{places.WORKER_PLACE_ROW}/name")
    form.new_question(
        "visit_description",
        None,
        None,
        calculate="instance('commcaresession-1')/commcaresession_list/commcaresession[id = /data/visit_type]/name",
    )
    declare_instance(form, "commcaresession", "jr://instance/session")
    declare_instance(form, "locations", "jr://fixture/locations")
    declare_instance(form, "locations-1", "jr://fixture/item-list:locations")
    declare_instance(form, "commcaresession-1", "jr://fixture/item-list:commcaresession")
    return form.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Community visits")
    _pages.turn_web_apps_on(authoring, app_id)
    make_tables(authoring, TABLES)
    places.make_organization(authoring)
    _pages.new_survey_module(authoring, app_id, name="Community visit")
    ops.upload_form_source(authoring, app_id, 0, 0, visit_source, "visit-source")
    return app_id


BASE = Base(
    id="hq-lookup-aliases",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "LOOKUP_TABLES", "LOCATIONS"})),
    exhibits=("expressions-and-data/tag-equal-to-an-instance-name-commcare-owns",),
    vellum=((0, 0),),
    worker_location=places.WORKER_PLACE,
)
