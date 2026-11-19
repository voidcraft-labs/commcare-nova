"""``hq-names``: an app made in HQ whose names hold the characters HQ's grammars take and Nova holds.

1. A new app (``views/apps.py::default_new_app``), named "Plot survey" on
   the app page (``edit_app_attr``).
2. A case list menu "Plots" of the case type ``plot``
   (``views/modules.py::new_module``), which adds a Registration Form and a
   Followup Form.
3. The registration form's source, written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``) and uploaded on the form page: a
   text question whose id holds a hyphen, ``plot-name``; a single select
   ``irrigated`` with one choice, ``yes``; a single select ``tenure`` one of
   whose choice values holds an apostrophe, ``farmer's``, its label under the
   text id the form builder gives it (``FARMERS_TEXT``); and text questions
   ``soil``, ``group_answer`` and ``status_answer``.
4. Its case management (``edit_form_actions``): the case's name from
   ``plot-name``; ``soil`` saved to the property ``soil-type``, which holds a
   hyphen; ``group_answer`` saved under the update key ``category`` and
   ``status_answer`` under ``state``.
5. The follow-up form: a text question ``visit-note``, uploaded on the form
   page. Both forms are then saved in HQ's form builder (``vellum``).
6. The menu's Search, saved on its Case List page
   (``edit_module_detail_screens``): one field, ``soil-type``, a name
   holding a hyphen.

Its configuration is the lane's floor with case search on and
``SYNC_SEARCH_CASE_CLAIM``, the flag HQ's Search options stand under and
that Nova's publish asks of a project space for an app with a Search. Web
Apps is off, as ``Application.cloudcare_enabled`` defaults, and its content
runs on Android, so its preselected declaration is Android only.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Plot survey"
MENU = "Plots"
CASE_TYPE = "plot"


# The text id HQ's form builder gives the label of the choice ``farmer's``: the question's path, then the choice's
# value with each character an attribute cannot hold written ``_`` (``javaRosa/util.js::getDefaultItextRoot``).
# ``XFormBuilder`` names it from the value as it stands (``get_text_id``), which no ``jr:itext`` reference can
# spell, so the form builder would load the choice with no label.
FARMERS_TEXT = "tenure-farmer_s-label"


def registration_source(name):
    """The registration form, as HQ's ``XFormBuilder`` writes it, with the label of the choice ``farmer's`` under
    the text id the form builder gives it (``FARMERS_TEXT``): the text's ``id`` and the choice label's
    ``jr:itext`` reference."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("plot-name", "Plot name", "string")
    xform.new_question("irrigated", "Irrigated", "select1", choices={"yes": "Yes"})
    xform.new_question(
        "tenure", "Who works the plot", "select1", choices={"farmer's": "The farmer", "shared": "Shared"}
    )
    xform.new_question("soil", "Soil", "string")
    xform.new_question("group_answer", "Crop group", "string")
    xform.new_question("status_answer", "Plot status", "string")
    # The form writer makes the elements it adds with no namespace (``lxml.builder.E``), which the source holds in
    # the XForms namespace once written, so they are found by local name.
    root = xform._etree
    written = xform.get_text_id("tenure", None, "farmer's")
    texts = root.xpath("//*[local-name()='text'][@id=$id]", id=written)
    labels = root.xpath("//*[local-name()='label'][@ref=$ref]", ref=f"jr:itext('{written}')")
    if len(texts) != 1 or len(labels) != 1:
        raise ValueError(f"The form writer wrote {len(texts)} texts and {len(labels)} labels for the choice farmer's.")
    texts[0].set("id", FARMERS_TEXT)
    labels[0].set("ref", f"jr:itext('{FARMERS_TEXT}')")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def follow_up_source(name):
    """The follow-up form, as HQ's ``XFormBuilder`` writes it: one text question whose id holds a hyphen."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("visit-note", "Visit note", "string")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.new_case_module(authoring, app_id, name=MENU, case_type=CASE_TYPE)
    ops.upload_form_source(authoring, app_id, 0, 0, registration_source, "registration-source")
    _pages.save_case_actions(
        authoring,
        app_id,
        0,
        0,
        name_path="/data/plot-name",
        updates={"soil-type": "/data/soil", "category": "/data/group_answer", "state": "/data/status_answer"},
    )
    ops.upload_form_source(authoring, app_id, 0, 1, follow_up_source, "follow-up-source")
    _pages.save_search_fields(authoring, app_id, 0, [("soil-type", "Soil type")])
    return app_id


BASE = Base(
    id="hq-names",
    build=build,
    configuration=Configuration(flags=frozenset({"SYNC_SEARCH_CASE_CLAIM"}), case_search_enabled=True),
    exhibits=(
        "questions/question-id-matching-xml-a-za-z-w",
        "questions/text-input-xsd-string",
        "questions/multiple-choice-select1-item",
        "questions/choice-value-containing-or",
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/update-case-update-property-question",
        "forms-and-case-writes/update-keys-location-id-hq-user-id-category-state",
        "forms-and-case-writes/update-key-whose-characters-after-the-ascii-first-are-all-core-s",
        "case-search/name-prompt-key-case-property",
    ),
    vellum=((0, 0), (0, 1)),
)
