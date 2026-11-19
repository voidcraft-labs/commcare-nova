"""``hq-places``: an app made in HQ whose form reads the worker's place in a project space's organization.

1. A new app (``views/apps.py::default_new_app``), named "Village reports"
   on the app page (``edit_app_attr``).
2. The project space's organization, made with HQ's own models
   (``locations/models.py::LocationType``, ``SQLLocation``), parents first,
   as HQ's organization pages save it: two levels, ``district`` and under it
   ``village``; the location property ``region_code``, as the Locations
   Fields page saves one (``custom_data_fields/models.py::
   CustomDataFieldsDefinition`` of ``locations/views.py::LocationFieldsView.field_type``,
   one ``Field``); two districts, each with two villages, every village
   holding its ``region_code``, which is six active places; and a fifth
   village archived with HQ's own ``SQLLocation.archive``. HQ gives each
   place its ``location_id`` (``SQLLocation.save``).
3. A survey menu "Village report" (``views/modules.py::new_module``) whose
   one form's source is written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``) and uploaded on the form page: a
   text question ``report_note`` and three hidden values that read the
   flat location list HQ's restore hands the worker
   (``instance('locations')/locations/location``, from
   ``jr://fixture/locations``): the name of the worker's place
   (``commcare_location_id`` of the worker's session data), the name of
   its parent, and its ``region_code``. The form is then saved in HQ's form
   builder (``vellum``).

The worker the lane makes for this base is assigned the village
``north-1`` (``Base.worker_location``). Its configuration is the lane's
floor with ``LOCATIONS``, without which HQ's restore holds no location list
(``locations/fixtures.py::should_sync_flat_fixture``). Web Apps is off, as
``Application.cloudcare_enabled`` defaults, and its content runs on
Android, so its preselected declaration is Android only.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.lookups import declare_instance
from proof.matrix.registry import Base

NAME = "Village reports"
MENU = "Village report"
WORKER_PLACE = "north-1"

LEVELS = (
    {"name": "District", "code": "district", "parent": None},
    {"name": "Village", "code": "village", "parent": "district"},
)
LOCATION_PROPERTY = {"slug": "region_code", "label": "Region code"}
# Parents first: each place's name, site code, level, parent's site code, region code and whether it is archived.
PLACES = (
    {"name": "North", "site_code": "north", "level": "district", "parent": None, "region": None},
    {"name": "South", "site_code": "south", "level": "district", "parent": None, "region": None},
    {"name": "Northfield", "site_code": "north-1", "level": "village", "parent": "north", "region": "N-1"},
    {"name": "Northbrook", "site_code": "north-2", "level": "village", "parent": "north", "region": "N-2"},
    {"name": "Southgate", "site_code": "south-1", "level": "village", "parent": "south", "region": "S-1"},
    {"name": "Southmere", "site_code": "south-2", "level": "village", "parent": "south", "region": "S-2"},
    {
        "name": "Southend",
        "site_code": "south-3",
        "level": "village",
        "parent": "south",
        "region": "S-3",
        "archived": True,
    },
)

WORKER = "instance('commcaresession')/session/user/data/commcare_location_id"
WORKER_PLACE_ROW = f"instance('locations')/locations/location[@id = {WORKER}]"
# A place in HQ's flat list names each ancestor by its level (``locations/fixtures.py::FlatLocationSerializer``:
# ``@<level code>_id``), and a village's parent is its district.
PARENT_PLACE_ROW = f"instance('locations')/locations/location[@id = {WORKER_PLACE_ROW}/@district_id]"


def make_organization(authoring):
    """The levels, the location property and the places, made with HQ's own models in the operation
    ``build:organization``: each level a ``LocationType``, the property a ``Field`` of the project space's
    ``CustomDataFieldsDefinition`` for places, and each place an ``SQLLocation`` saved parents first, the archived
    one archived after the rest by ``SQLLocation.archive``."""
    from corehq.apps.custom_data_fields.models import CustomDataFieldsDefinition, Field
    from corehq.apps.locations.models import LocationType, SQLLocation
    from corehq.apps.locations.views import LocationFieldsView

    state = authoring.state
    digest = json.dumps([LEVELS, LOCATION_PROPERTY, PLACES], sort_keys=True).encode()
    with authoring.step("build:organization", digest):
        levels = {}
        for level in LEVELS:
            levels[level["code"]] = LocationType.objects.create(
                domain=state.domain,
                name=level["name"],
                code=level["code"],
                parent_type=None if level["parent"] is None else levels[level["parent"]],
            )
        definition = CustomDataFieldsDefinition.get_or_create(state.domain, LocationFieldsView.field_type)
        definition.set_fields([Field(slug=LOCATION_PROPERTY["slug"], label=LOCATION_PROPERTY["label"])])
        definition.save()
        made = {}
        for place in PLACES:
            location = SQLLocation(
                domain=state.domain,
                name=place["name"],
                site_code=place["site_code"],
                location_type=levels[place["level"]],
                parent=None if place["parent"] is None else made[place["parent"]],
                metadata={} if place["region"] is None else {LOCATION_PROPERTY["slug"]: place["region"]},
            )
            location.save()
            made[place["site_code"]] = location
        for place in PLACES:
            if place.get("archived"):
                made[place["site_code"]].archive()


def report_source(name):
    """The report form, as HQ's ``XFormBuilder`` writes it, with the session and the location list declared."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("report_note", "What happened in the village this week?", "string")
    xform.new_question("my_village", None, None, calculate=f"{WORKER_PLACE_ROW}/name")
    xform.new_question("my_district", None, None, calculate=f"{PARENT_PLACE_ROW}/name")
    xform.new_question("my_region", None, None, calculate=f"{WORKER_PLACE_ROW}/location_data/region_code")
    declare_instance(xform, "commcaresession", "jr://instance/session")
    declare_instance(xform, "locations", "jr://fixture/locations")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    make_organization(authoring)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    ops.upload_form_source(authoring, app_id, 0, 0, report_source, "report-source")
    return app_id


BASE = Base(
    id="hq-places",
    build=build,
    configuration=Configuration(privileges=frozenset({"LOCATIONS"})),
    exhibits=(
        "questions/text-input-xsd-string",
        "questions/hidden-value-data-node-bind-no-control-with-calculate-or-default",
        "questions/bind-calculate-on-a-hidden-value",
        "expressions-and-data/locations-flat-jr-fixture-locations-read-in-an-expression",
        "menus-and-case-lists/module-with-case-type-survey-module",
    ),
    vellum=((0, 0),),
    worker_location=WORKER_PLACE,
)
