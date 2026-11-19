"""``hq-plain``: an app holding only what Nova holds, made as a person makes it in HQ's own pages and form builder.

1. A new app (``views/apps.py::default_new_app``), named "Household visits"
   on the app page (``edit_app_attr``) and with Web Apps turned on on the
   settings page: ``Application.cloudcare_enabled`` defaults to false and the
   app declares both platforms, so with the setting off Nova's publish would
   stop to ask before turning it on, which is ``hq-new-app``'s to show.
2. A case list menu "Households" of the case type ``household``
   (``views/modules.py::new_module``), which adds a Registration Form and a
   Followup Form, each opening or updating the case always.
3. The registration form's source written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``): a text question ``head_name``, an
   integer ``members``, a single select ``village`` (``north``, ``south``), a
   date ``visit_date``, a group ``notes`` holding a text question ``remark``,
   and a hidden value ``members_plus_one`` calculating ``/data/members + 1``,
   uploaded on the form page. The form builder saves it after the build
   (``vellum``), so every byte of it is the builder's own.
4. Its case management (``edit_form_actions``): the case's name from
   ``head_name``, and ``members``, ``village`` and ``visit_date`` saved to
   the case.
5. The follow-up form: a label, an integer ``members`` and a text ``remark``
   required where ``members > 5``, uploaded on the form page. ``members``'
   Default Value is typed in the form builder as a person types it,
   ``#case/members`` (``ops.builder_save``'s edit), since the basic Case
   Management page offers no load. Its case management saves ``members`` and
   ``remark``, and writes no ``case_preload``.
6. The case list shows the name and ``village``, sorted by ``village``; the
   case detail shows the name, ``village``, ``members`` and ``visit_date`` as
   a date (``edit_module_detail_screens``).

It saves no setting: an app a person just made holds none. Its configuration
is the lane's floor with ``CLOUDCARE``, which the content rule derives for an
app Web Apps lists (``proof/checks/configurations.py::_needs_cloudcare``).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Household visits"
MENU = "Households"
CASE_TYPE = "household"


def registration_source(name):
    """The registration form, as HQ's ``XFormBuilder`` writes it."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("head_name", "Head of household", "string")
    xform.new_question("members", "Members", "int")
    xform.new_question("village", "Village", "select1", choices={"north": "North", "south": "South"})
    xform.new_question("visit_date", "Visit date", "date")
    notes = xform.new_group("notes", "Notes")
    notes.new_question("remark", "Remark", "string")
    xform.new_question("members_plus_one", None, None, calculate="/data/members + 1")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def follow_up_source(name):
    """The follow-up form: ``XFormBuilder``'s ``members`` and ``remark``, after a label written in the shape HQ's
    own follow-up form holds one (``templates/app_manager/default_followup_form.xml``: a data node, its bind, its
    itext and a ``trigger`` of appearance ``minimal``), which ``XFormBuilder`` has no type for."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder
    from lxml import etree

    xform = XFormBuilder(name)
    xform.new_question("members", "Members", "int")
    xform.new_question("remark", "Remark", "string", required="/data/members > 5")
    root = xform._etree
    namespaces = xform.ns
    data = root.xpath("./h:head/x:model/x:instance/d:data", namespaces=namespaces)[0]
    data.insert(0, etree.Element(f"{{{namespaces['d']}}}visit_label"))
    model = root.xpath("./h:head/x:model", namespaces=namespaces)[0]
    # XFormBuilder makes its binds with lxml's ``E``, which names no namespace while the form is in memory; the
    # form's default namespace is theirs once the source is written out.
    first_bind = model.find("bind")
    first_bind.addprevious(etree.Element(f"{{{namespaces['x']}}}bind", nodeset="/data/visit_label"))
    translation = root.xpath("./h:head/x:model/x:itext/x:translation", namespaces=namespaces)[0]
    text = etree.Element(f"{{{namespaces['x']}}}text", id="visit_label-label")
    etree.SubElement(text, f"{{{namespaces['x']}}}value").text = "Ask how the household is doing."
    translation.insert(0, text)
    body = root.xpath("./h:body", namespaces=namespaces)[0]
    trigger = etree.Element(f"{{{namespaces['x']}}}trigger", ref="/data/visit_label", appearance="minimal")
    etree.SubElement(trigger, f"{{{namespaces['x']}}}label", ref="jr:itext('visit_label-label')")
    body.insert(0, trigger)
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_case_module(authoring, app_id, name=MENU, case_type=CASE_TYPE)
    ops.upload_form_source(authoring, app_id, 0, 0, registration_source, "registration-source")
    _pages.save_case_actions(
        authoring,
        app_id,
        0,
        0,
        name_path="/data/head_name",
        updates={"members": "/data/members", "village": "/data/village", "visit_date": "/data/visit_date"},
    )
    ops.upload_form_source(authoring, app_id, 0, 1, follow_up_source, "follow-up-source")
    ops.builder_save(
        authoring,
        app_id,
        0,
        1,
        edit={"path": "/data/members", "property": "defaultValue", "value": "#case/members", "way": "builder-model"},
    )
    _pages.save_case_actions(authoring, app_id, 0, 1, updates={"members": "/data/members", "remark": "/data/remark"})
    _pages.save_case_list(
        authoring,
        app_id,
        0,
        columns=[_pages.column("name", "Name"), _pages.column("village", "Village")],
        sort_elements=[
            {
                "field": "village",
                "type": "plain",
                "direction": "ascending",
                "blanks": "first",
                "display": "",
                "sort_calculation": "",
            }
        ],
    )
    _pages.save_case_detail(
        authoring,
        app_id,
        0,
        columns=[
            _pages.column("name", "Name"),
            _pages.column("village", "Village"),
            _pages.column("members", "Members"),
            _pages.column("visit_date", "Visit date", format="date"),
        ],
    )
    return app_id


BASE = Base(
    id="hq-plain",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE"})),
    exhibits=(
        "application-and-settings/40-hq-cloudcare-enabled",
        "questions/text-input-xsd-string",
        "questions/integer-xsd-int-xsd-integer-read-as-the-same",
        "questions/date-xsd-date",
        "questions/hidden-value-data-node-bind-no-control-with-calculate-or-default",
        "questions/bind-calculate-on-a-hidden-value",
        "questions/bind-required-expr",
        "questions/setvalue-event-xforms-ready-default-on-a-question-outside",
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/update-case-update-property-question",
        "forms-and-case-writes/update-case-condition-always",
        "menus-and-case-lists/module-with-case-type-case-list-module",
        "menus-and-case-lists/2-date-date-format-d-m-y-d-m-y-m-d-y-m-d-y-b-d-y",
    ),
    vellum=((0, 0), (0, 1)),
)
