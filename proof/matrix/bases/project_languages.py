"""A worker's three different wordings carried under en, eng and qaa.

The Languages page saves all three spellings. Each language has its own field
label in the form. The hand
edit makes the project language the runtime default, then edits its wording.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base


def form_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    form.new_question(
        "landmark",
        {"en": "Nearest landmark", "eng": "Local landmark", "qaa": "Meeting place"},
        "string",
    )
    return form.tostring(xml_declaration=True).decode("utf-8")


def build(authoring):
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Site visit")
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.set_languages(authoring, app_id, ("en", "eng", "qaa"))
    _pages.new_survey_module(authoring, app_id, name="Visit")
    ops.upload_form_source(authoring, app_id, 0, 0, form_source, "landmark-source")
    return app_id


BASE = Base(
    id="hq-project-languages",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE"})),
    exhibits=(
        "application-and-settings/langs-code-nova-s-language-registry-cannot-name",
        "application-and-settings/langs-order-langs-0-default",
        "questions/label-default-text-itext-value",
    ),
    vellum=((0, 0),),
)
