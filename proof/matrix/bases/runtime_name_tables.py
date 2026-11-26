"""``hq-runtime-name-tables``: an app made in HQ in a project space whose lookup tables are tagged with ids HQ's
form builder holds for itself, beside forms that read the runtime instances of the same names.

HQ's form designer hands its form builder the session, a registry's cases and every table of the project space
under its bare tag, and the builder indexes them by id with the instances it knows
(``views/formdesigner.py::get_form_data_schema``, ``Vellum/src/form.js::updateKnownInstances``). So in a project
space holding a table tagged ``locations``, a form saved in the builder before the table arrived reads the
worker's places undeclared (HQ's build declares ``jr://fixture/locations``,
``suite_xml/post_process/instances.py``), and a form saved after it reads the table under the same id, declared
with the table's source (``jr://fixture/item-list:locations``). Nova must read each as what it reads, decided by
the declaration and the build's own resolution, never by the bare id, and its publish must keep both
(``lib/lookup/constants.ts::FORM_BUILDER_COLLIDING_TAGS``).

1. A new app named "Field office" (``views/apps.py::default_new_app``, ``edit_app_attr``).
2. The project space's organization (``places.make_organization``) and one table per id HQ's form builder holds,
   made with HQ's own models (``lookups.make_tables``): ``commcaresession``, ``registry``, ``groups``,
   ``reports``, ``locations``, ``results``, ``search-input``, ``selected_cases`` and ``case-search-fixture``, each
   with a ``code`` field and one row, and a table ``zz_after`` sorting after them all, so the builder indexes an id
   after each one's own (the order that breaks a form under ``hasOwnProperty``).
3. A survey menu "Office" whose first form, "Where I work", HQ's ``XFormBuilder`` writes and the form page
   uploads, unsaved by the builder since the tables arrived: hidden values counting the worker's places
   (``instance('locations')/locations/location``) and groups (``instance('groups')/groups/group``), neither
   declared, as the builder leaves a read of an instance it does not know. Its second form, a "Survey" form the menu's add-form button adds, reads
   each table under its bare tag, declared with the table's source as the builder declares one, and is saved in
   the builder (``vellum``) with the tables in the project space.
4. A case menu "Households" whose registration form opens a ``household`` case and whose follow-up form defaults
   ``members`` to the case's (``instance('casedb')`` through ``instance('commcaresession')``), both written by
   ``XFormBuilder`` and unsaved by the builder: forms made before the ``commcaresession`` table arrived.

The worker the lane makes is assigned the village ``north-1`` (``Base.worker_location``). The configuration is
the lane's floor with ``LOCATIONS`` and ``LOOKUP_TABLES``.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.lookups import declare_instance, make_tables
from proof.matrix.bases.places import WORKER_PLACE, make_organization
from proof.matrix.registry import Base

NAME = "Field office"
OFFICE = "Office"
HOUSEHOLDS = "Households"
CASE_TYPE = "household"

# The ids HQ's form builder holds (``lib/lookup/constants.ts::FORM_BUILDER_COLLIDING_TAGS``) but
# ``hasOwnProperty``, under which no form in the project space opens.
COLLIDING = (
    "commcaresession",
    "registry",
    "groups",
    "reports",
    "locations",
    "results",
    "search-input",
    "selected_cases",
    "case-search-fixture",
)
TABLES = tuple({"tag": tag, "fields": ("code",), "rows": (("one",),)} for tag in COLLIDING) + (
    # Sorts after every colliding tag, so the builder indexes an id after each one's own.
    {"tag": "zz_after", "fields": ("code",), "rows": (("one",),)},
)


def where_i_work_source(name):
    """Counts of the worker's places and groups, read undeclared as a person types them in the builder."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("office_note", "What happened at the office this week?", "string")
    xform.new_question("my_places", None, None, calculate="count(instance('locations')/locations/location)")
    xform.new_question("my_groups", None, None, calculate="count(instance('groups')/groups/group)")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def _question(tag):
    return "rows_" + tag.replace("-", "_")


# A form reading the commcaresession table under that bare id is one CommCare HQ's build gives its own session
# data to under the same name (its meta block), which Nova refuses as it comes in
# (``form-data-source-conflict``); every other id is read here.
FORM_READ = tuple(tag for tag in COLLIDING if tag != "commcaresession")


def table_reads_source(name):
    """A count of each table's rows, each table declared under its bare tag with its own source."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("table_note", "Which tables did you check?", "string")
    for tag in FORM_READ:
        xform.new_question(_question(tag), None, None, calculate=f"count(instance('{tag}')/{tag}_list/{tag})")
    for tag in FORM_READ:
        declare_instance(xform, tag, f"jr://fixture/item-list:{tag}")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def registration_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("head_name", "Head of household", "string")
    xform.new_question("members", "Members", "int")
    return xform.tostring(xml_declaration=True).decode("utf-8")


CASE_MEMBERS = (
    "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/members"
)


def follow_up_source(name):
    """``members`` defaulted to the case's, read through the session and the case database, both declared."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder
    from lxml import etree

    xform = XFormBuilder(name)
    xform.new_question("members", "Members", "int")
    declare_instance(xform, "casedb", "jr://instance/casedb")
    declare_instance(xform, "commcaresession", "jr://instance/session")
    model = xform._etree.xpath("./h:head/x:model", namespaces=xform.ns)[0]
    model.append(
        etree.Element(
            f"{{{xform.ns['x']}}}setvalue", event="xforms-ready", ref="/data/members", value=CASE_MEMBERS
        )
    )
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    make_organization(authoring)
    make_tables(authoring, TABLES)
    _pages.new_survey_module(authoring, app_id, name=OFFICE)
    ops.upload_form_source(authoring, app_id, 0, 0, where_i_work_source, "where-i-work-source")
    _pages.new_form(authoring, app_id, 0)
    ops.upload_form_source(authoring, app_id, 0, 1, table_reads_source, "table-reads-source")
    _pages.new_case_module(authoring, app_id, name=HOUSEHOLDS, case_type=CASE_TYPE)
    ops.upload_form_source(authoring, app_id, 1, 0, registration_source, "registration-source")
    _pages.save_case_actions(
        authoring, app_id, 1, 0, name_path="/data/head_name", updates={"members": "/data/members"}
    )
    ops.upload_form_source(authoring, app_id, 1, 1, follow_up_source, "follow-up-source")
    return app_id


BASE = Base(
    id="hq-runtime-name-tables",
    build=build,
    configuration=Configuration(privileges=frozenset({"LOCATIONS", "LOOKUP_TABLES"})),
    exhibits=("expressions-and-data/tag-equal-to-an-instance-name-commcare-owns",),
    vellum=((0, 1),),
    worker_location=WORKER_PLACE,
)
