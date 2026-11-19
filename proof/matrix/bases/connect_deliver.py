"""``hq-connect-deliver``: a CommCare Connect deliver app made in HQ, with Web Apps turned on.

1. A new app (``views/apps.py::default_new_app``), named "Household
   delivery" on the app page (``edit_app_attr``), with Web Apps turned on on
   the settings page. Location capture on every form stays off, as
   ``Application.auto_gps_capture`` defaults, so Nova's first publish turns
   it on, as it does for every Connect app (``connect-app-captures-location``).
   The source holding it on is the variant
   ``hq-connect-deliver/auto-gps-capture-on``.
2. A survey menu "Household visits" (``views/modules.py::new_module``) with
   two forms, each written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``) and uploaded on the form page:
   "Deliver visit", whose text questions ``household_id`` and
   ``household_name`` the deliver unit ``visit_unit`` reads as the visit's
   entity id and name; and "Follow-up task", a text question ``task_note``
   beside the task ``follow_up_task``. A deliver unit and a task sit in two
   forms, since one form holding both is no Connect form Nova holds.
   ``XFormBuilder`` has no type for a Connect block, so each is written in
   the shape HQ's form builder saves one (``Vellum/src/commcareConnect.js``,
   each mug's ``childNodes``): a data node named for the block's id with
   ``vellum:role``, holding the block's own element in Connect's namespace
   with the block's id and its leaves, a bind on the wrapper, and a
   calculate bind on each leaf the block computes. Both forms are then saved
   in HQ's form builder (``vellum``), whose Connect plugin the flag loads.

It is read as an app that runs on Android only, which a Connect app is, so
Nova's first publish turns Web Apps off (``web-apps-turned-off``). Its
configuration is the lane's floor with ``COMMCARE_CONNECT``, the flag HQ's
form builder offers Connect blocks under, ``DATA_FORWARDING``, without which
no submission reaches Connect (``motech/repeaters/models.py::domain_can_forward``),
and ``CLOUDCARE``, which the settings page needs to keep Web Apps on
(``views/apps.py::edit_app_attr``).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base, Declaration

NAME = "Household delivery"
MENU = "Household visits"
CONNECT_XMLNS = "http://commcareconnect.com/data/v1/learn"
VELLUM_XMLNS = "http://commcarehq.org/xforms/vellum"


def new_form(authoring, app_id, menu, *, name):
    """A form added to the menu at ``menu`` as its form list's Add Form adds one (``views/forms.py::new_form``
    with ``form_type`` ``form`` and ``case_action`` ``none``, which names it "Survey"), then named ``name`` on its
    settings page."""
    from proof.hq import operations

    with authoring.step(f"build:new-form:{menu}", name.encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body([("form_type", "form"), ("case_action", "none")])
        ops.post(authoring, "new_form", [app_id, module.unique_id], body, content_type, "a new form", redirects=True)
    # The menu's forms list, not ``get_forms``, which yields them (``models/base.py::IndexedSchema.Getter``).
    form = len(operations.held_app(authoring.state, app_id).get_module(menu).forms) - 1
    _pages.save_form_attributes(authoring, app_id, menu, form, [("name", name)], "name")


def connect_block(xform, block_id, role, element, leaves, *, calculates=None):
    """A Connect block ``block_id`` in the shape HQ's form builder saves: the data node ``block_id`` with
    ``vellum:role`` ``role``, holding ``element`` in Connect's namespace with ``id`` the block's id and one child a
    leaf of ``leaves`` (``(name, text)``, the text written into the leaf, or None), a bind on the wrapper with its
    ``vellum:nodeset``, and a bind on each leaf ``calculates`` names, calculating its expression, after the form's
    own binds."""
    from lxml import etree

    data = xform._etree.xpath("./h:head/x:model/x:instance/d:data", namespaces=xform.ns)[0]
    wrapper = etree.SubElement(
        data, f"{{{xform.ns['d']}}}{block_id}", {f"{{{VELLUM_XMLNS}}}role": role}, nsmap={"vellum": VELLUM_XMLNS}
    )
    own = etree.SubElement(wrapper, f"{{{CONNECT_XMLNS}}}{element}", id=block_id, nsmap={None: CONNECT_XMLNS})
    for name, text in leaves:
        leaf = etree.SubElement(own, f"{{{CONNECT_XMLNS}}}{name}")
        if text is not None:
            leaf.text = text
    model = xform._etree.xpath("./h:head/x:model", namespaces=xform.ns)[0]
    model.append(
        etree.Element(
            "bind",
            {f"{{{VELLUM_XMLNS}}}nodeset": f"#form/{block_id}", "nodeset": f"/data/{block_id}"},
            nsmap={"vellum": VELLUM_XMLNS},
        )
    )
    for name, calculate in (calculates or {}).items():
        attributes = {"nodeset": f"/data/{block_id}/{element}/{name}"}
        if calculate is not None:
            attributes["calculate"] = calculate
        model.append(etree.Element("bind", attributes))


def written(xform):
    """The form's text. The form builder's namespace is declared on each element that uses it: lxml cannot add a
    declaration to the root ``XFormBuilder`` parsed, and tidying the root's declarations would drop ``jr``, which
    the form's itext references name only inside attribute values."""
    return xform.tostring(xml_declaration=True).decode("utf-8")


def deliver_source(name):
    """The deliver form: two text questions and the deliver unit that reads them."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("household_id", "Household ID", "string")
    xform.new_question("household_name", "Household name", "string")
    connect_block(
        xform,
        "visit_unit",
        "ConnectDeliverUnit",
        "deliver",
        (("name", "Household visit"), ("entity_id", None), ("entity_name", None), ("work_area_id", None)),
        calculates={"entity_id": "/data/household_id", "entity_name": "/data/household_name", "work_area_id": None},
    )
    return written(xform)


def task_source(name):
    """The task form: a text question beside the task."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("task_note", "What is left to do?", "string")
    connect_block(
        xform,
        "follow_up_task",
        "ConnectTask",
        "task",
        (("name", "Return visit"), ("description", "Visit the household again within a week")),
    )
    return written(xform)


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    _pages.save_form_attributes(authoring, app_id, 0, 0, [("name", "Deliver visit")], "name")
    ops.upload_form_source(authoring, app_id, 0, 0, deliver_source, "deliver-source")
    new_form(authoring, app_id, 0, name="Follow-up task")
    ops.upload_form_source(authoring, app_id, 0, 1, task_source, "task-source")
    return app_id


BASE = Base(
    id="hq-connect-deliver",
    build=build,
    configuration=Configuration(
        flags=frozenset({"COMMCARE_CONNECT"}), privileges=frozenset({"CLOUDCARE", "DATA_FORWARDING"})
    ),
    exhibits=(
        "application-and-settings/40-hq-cloudcare-enabled",
        "application-and-settings/connect-app-opened-in-the-connect-app",
        "questions/text-input-xsd-string",
        "questions/connect-deliver-unit",
        "questions/connect-task",
        "menus-and-case-lists/module-with-case-type-survey-module",
    ),
    vellum=((0, 0), (0, 1)),
    declaration=Declaration(runs_only_on="android"),
)
