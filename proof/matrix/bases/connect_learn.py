"""``hq-connect-learn``: a CommCare Connect learn app made in HQ.

1. A new app (``views/apps.py::default_new_app``), named "Hygiene training"
   on the app page (``edit_app_attr``).
2. A survey menu "Training" (``views/modules.py::new_module``) whose one
   form, "Hand washing", is written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``) and uploaded on the form page: an
   integer question ``quiz_score``, the learn module ``intro_module`` with
   its name, description and time estimate, and the assessment
   ``intro_check``, whose score is the answer to ``quiz_score``. Each block
   is written in the shape HQ's form builder saves one
   (``proof/matrix/bases/connect_deliver.py::connect_block``). The form is
   then saved in HQ's form builder (``vellum``).

A Connect app is a learn app or a deliver app, so this base holds the learn
blocks ``hq-connect-deliver`` cannot. Web Apps is off, as
``Application.cloudcare_enabled`` defaults, and a Connect app runs on
Android only, so its preselected declaration is Android only. Its
configuration is the lane's floor with ``COMMCARE_CONNECT`` and
``DATA_FORWARDING``.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.connect_deliver import connect_block, written
from proof.matrix.registry import Base

NAME = "Hygiene training"
MENU = "Training"
FORM = "Hand washing"


def training_source(name):
    """The training form: the quiz's score, the learn module and the assessment that reads the score."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("quiz_score", "Quiz score", "int")
    connect_block(
        xform,
        "intro_module",
        "ConnectLearnModule",
        "module",
        (("name", "Hand washing"), ("description", "Why and when to wash hands"), ("time_estimate", "5")),
    )
    connect_block(
        xform,
        "intro_check",
        "ConnectAssessment",
        "assessment",
        (("user_score", None),),
        calculates={"user_score": "/data/quiz_score"},
    )
    return written(xform)


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    _pages.save_form_attributes(authoring, app_id, 0, 0, [("name", FORM)], "name")
    ops.upload_form_source(authoring, app_id, 0, 0, training_source, "training-source")
    return app_id


BASE = Base(
    id="hq-connect-learn",
    build=build,
    configuration=Configuration(flags=frozenset({"COMMCARE_CONNECT"}), privileges=frozenset({"DATA_FORWARDING"})),
    exhibits=(
        "application-and-settings/connect-app-opened-in-the-connect-app",
        "questions/integer-xsd-int-xsd-integer-read-as-the-same",
        "questions/connect-learn-module",
        "questions/connect-assessment",
        "menus-and-case-lists/module-with-case-type-survey-module",
    ),
    vellum=((0, 0),),
)
