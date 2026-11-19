"""``hq-expressions``: an app made in HQ whose one form holds each expression Nova's first publish writes another way.

1. A new app (``views/apps.py::default_new_app``), named "Visit checks" on
   the app page (``edit_app_attr``).
2. A global lookup table ``kinds`` (fields ``code`` and ``name``, two rows)
   made with HQ's own models (``fixtures/models.py::LookupTable``,
   ``LookupTableRow``), as a project space holds one.
3. A survey menu "Checks" (``views/modules.py::new_module`` with
   ``module_type`` ``survey``), whose one form's source is written by HQ's
   own form writer (``xform_builder.py::XFormBuilder``), uploaded on the form
   page and saved in the form builder (``vellum``):

   - two date-and-time questions ``started_at`` and ``finished_at`` and a
     Hidden Value ``order`` comparing them bare
     (``if(/data/finished_at > /data/started_at, ...)``): Core compares two
     dates and times by their day (``FunctionUtils.toNumeric`` of a ``Date``
     is ``DateUtils.daysSinceEpoch``), and Nova's publish compares them by
     the moment (``instant-comparison``);
   - a text question ``code`` and a Hidden Value ``kind_name`` reading the
     table's row for it with no guard for a code no row holds
     (``empty-rows-guard``);
   - a repeat ``visits`` whose rows each read the table by the row's own
     answer, written as the absolute path (``/data/visits/visit_code``) and
     not from ``current()`` (``row-predicate-current``);
   - a Hidden Value ``language`` reading the session's
     ``context/applanguage`` with no guard for a runtime that writes none
     (``absent-session-value-guard``);
   - a text question ``code_again`` whose Default Value reads ``code``
     (``default-reads-current``, which changes no behavior and states no
     first-publish change).

   The table and the session are declared as HQ's form builder declares
   them, ``item-list:kinds`` from ``jr://fixture/item-list:kinds`` and
   ``commcaresession`` from ``jr://instance/session``.

Its configuration is the lane's floor with ``LOOKUP_TABLES``, which a form
reading a table needs (``proof/checks/configurations.py::_needs_lookup_tables``).
Web Apps stays off, as ``Application.cloudcare_enabled`` defaults, and a
date-and-time question runs on Android alone (``lib/domain/platforms.ts``),
so its preselected declaration is Android only.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Visit checks"
MENU = "Checks"
TABLE = "kinds"
ROWS = (("clinic", "Clinic visit"), ("home", "Home visit"))
# The two instances the form reads, as HQ's form builder declares them.
INSTANCES = (
    ("item-list:kinds", "jr://fixture/item-list:kinds"),
    ("commcaresession", "jr://instance/session"),
)
KIND_OF = "instance('item-list:kinds')/kinds_list/kinds[code = {key}]/name"


def make_table(authoring):
    """The global lookup table ``kinds``, made with HQ's own models in the operation ``build:table:kinds``."""
    with authoring.step(f"build:table:{TABLE}"):
        from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow, TypeField

        table = LookupTable.objects.create(
            domain=authoring.state.domain,
            tag=TABLE,
            is_global=True,
            fields=[TypeField(name="code"), TypeField(name="name")],
        )
        for sort_key, (code, name) in enumerate(ROWS):
            LookupTableRow.objects.create(
                domain=authoring.state.domain,
                table=table,
                fields={"code": [Field(value=code)], "name": [Field(value=name)]},
                sort_key=sort_key,
            )


def declare_instances(xform, instances):
    """Each ``(id, src)`` of ``instances`` declared after the form's main instance, as HQ's form builder writes a
    secondary instance."""
    from lxml import etree

    model = xform._etree.xpath("./h:head/x:model", namespaces=xform.ns)[0]
    main = model.find(f"{{{xform.ns['x']}}}instance")
    for instance_id, src in reversed(instances):
        main.addnext(etree.Element(f"{{{xform.ns['x']}}}instance", id=instance_id, src=src))


def checks_source(name):
    """The form, as HQ's ``XFormBuilder`` writes it, with the two instances it reads declared."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("started_at", "Started at", "dateTime")
    xform.new_question("finished_at", "Finished at", "dateTime")
    xform.new_question("order", None, None, calculate="if(/data/finished_at > /data/started_at, 'after', 'not after')")
    xform.new_question("code", "Visit kind code", "string")
    xform.new_question("kind_name", None, None, calculate=KIND_OF.format(key="/data/code"))
    visits = xform.new_group("visits", "Visits", data_type="repeatGroup")
    visits.new_question("visit_code", "Visit code", "string")
    visits.new_question("visit_kind", None, None, calculate=KIND_OF.format(key="/data/visits/visit_code"))
    xform.new_question("language", None, None, calculate="instance('commcaresession')/session/context/applanguage")
    xform.new_question("code_again", "Visit kind code again", "string", value="/data/code")
    declare_instances(xform, INSTANCES)
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    make_table(authoring)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    ops.upload_form_source(authoring, app_id, 0, 0, checks_source, "checks-source")
    return app_id


BASE = Base(
    id="hq-expressions",
    build=build,
    configuration=Configuration(privileges=frozenset({"LOOKUP_TABLES"})),
    exhibits=(
        "questions/text-input-xsd-string",
        "questions/date-and-time-xsd-datetime",
        "questions/hidden-value-data-node-bind-no-control-with-calculate-or-default",
        "questions/bind-calculate-on-a-hidden-value",
        "questions/a-default-value-that-reads-form-nodes",
        "questions/repeat-group-user-controlled",
        "expressions-and-data/item-list-tag-read-in-any-other-expression",
    ),
    vellum=((0, 0),),
)
