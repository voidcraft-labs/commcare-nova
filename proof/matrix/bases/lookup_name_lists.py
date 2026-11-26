"""``hq-lookup-name-lists``: an app made in HQ whose case list reads a lookup column named with letters outside ASCII
in its filter and in a calculated column, beside a menu with a search a person can save.

HQ checks a display condition and the search options' conditions with js-xpath, which reads unaccented names
alone (``hq-lookup-names/non-ascii-column-in-form-condition``); its build checks a case list's filter and columns
with nothing of the kind, and Formplayer and Web Apps read them. This base holds the reads HQ builds; its variants
hold the ones HQ's checks refuse.

1. A new app named "Site visits" with Web Apps on (``views/apps.py::default_new_app``, ``edit_app_attr``).
2. The table ``zones`` of ``hq-lookup-names`` (``code``, ``clé``, ``région``, ``名前``, ``code.1``,
   ``zone.name``), made with HQ's own models and saved on its table editor (``lookup_names.make_saved_tables``).
3. A case menu "Sites" of ``site``: a registration form writing the site's ``zone`` code, a follow-up form, and a
   case list of the name and a calculated column of the zone's ``région``, filtered to the sites whose zone's
   ``région`` reads Upland, as the Case List tab saves them (``edit_module_detail_screens``).
4. A case menu "Site search" of ``site`` with its follow-up form alone, whose search, saved on the Case List page,
   asks for the zone and opens on its own (``auto_launch``): HQ's own search, which the variants change.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages, search
from proof.matrix.bases.case_lists import _column, save_list
from proof.matrix.bases.lookup_names import ZONES, make_saved_tables
from proof.matrix.registry import Base

NAME = "Site visits"
SITES = "Sites"
SITE_SEARCH = "Site search"
SITE = "site"
# A zone's region, read off the lookup table by the case's own zone code.
REGION_OF_CASE = "instance('item-list:zones')/zones_list/zones[code = current()/zone][1]/région"
# The case's zone among those whose région reads Upland.
REGION_FILTER = "zone = instance('item-list:zones')/zones_list/zones[région = 'Upland'][1]/code"


def site_registration_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    form.new_question("site_name", "Site name", "string")
    form.new_question("zone", "Zone code", "string")
    return form.tostring(xml_declaration=True).decode("utf-8")


def site_follow_up_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    form.new_question("note", "Note", "string")
    return form.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)
    make_saved_tables(authoring, (ZONES,))
    _pages.new_case_module(authoring, app_id, name=SITES, case_type=SITE)
    ops.upload_form_source(authoring, app_id, 0, 0, site_registration_source, "site-registration-source")
    _pages.save_case_actions(authoring, app_id, 0, 0, name_path="/data/site_name", updates={"zone": "/data/zone"})
    ops.upload_form_source(authoring, app_id, 0, 1, site_follow_up_source, "site-follow-up-source")
    save_list(
        authoring,
        app_id,
        0,
        columns=[_column("name", "Name"), _column(REGION_OF_CASE, "Region", useXpathExpression=True)],
        sort_elements=[],
        filter=REGION_FILTER,
    )
    _pages.new_case_module(authoring, app_id, name=SITE_SEARCH, case_type=SITE)
    _pages.delete_form(authoring, app_id, 1, 0)
    ops.upload_form_source(authoring, app_id, 1, 0, site_follow_up_source, "site-search-follow-up-source")
    search.save_search(authoring, app_id, 1, fields=[search.field("zone", "Zone")], auto_launch=True)
    return app_id


BASE = Base(
    id="hq-lookup-name-lists",
    build=build,
    configuration=Configuration(
        flags=frozenset({"SYNC_SEARCH_CASE_CLAIM"}),
        privileges=frozenset({"CLOUDCARE", "LOOKUP_TABLES"}),
        case_search_enabled=True,
    ),
    exhibits=("expressions-and-data/tag-or-field-name-with-non-ascii-letters",),
)
