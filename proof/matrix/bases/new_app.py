"""``hq-new-app``: an app just made in HQ, as a person first makes one.

A new app (``views/apps.py::default_new_app``), then a case list menu with no
case type posted, so its type is ``case``
(``views/modules.py::_init_module_case_type``), whose registration form is
given one text question (written by HQ's own form writer, uploaded on the
form page and saved in the form builder) and its case name from it
(``edit_form_actions``). It saves no setting and leaves Web Apps off, as
``Application.cloudcare_enabled`` defaults, so a just-created app holds each
value HQ keeps at its own default that a reading meets (the ``KEPT_AT_HQ`` rows on
this base, ``lib/commcare/surface/keptAtHq.ts``). Web Apps off is
``web-apps-turned-on``'s shape here, never an exhibit of its setting's entry: a
held value at HQ's default counts no use. It is read as an app that runs on
both platforms, so Nova's first publish turns Web Apps on, which the reading
says (``web-apps-turned-on``).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base, Declaration


def registration_source(name):
    """The registration form, as HQ's ``XFormBuilder`` writes it: one text question."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("full_name", "Full name", "string")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build_new_app(authoring) -> str:
    """The app as this base makes it, which ``hq-saved-pages`` saves on every page after."""
    app_id = _pages.new_app(authoring)
    _pages.new_case_module(authoring, app_id)
    ops.upload_form_source(authoring, app_id, 0, 0, registration_source, "registration-source")
    _pages.save_case_actions(authoring, app_id, 0, 0, name_path="/data/full_name")
    return app_id


BASE = Base(
    id="hq-new-app",
    build=build_new_app,
    configuration=Configuration(),
    exhibits=(
        "questions/text-input-xsd-string",
        "forms-and-case-writes/open-case-name-update-question-path",
        # The rows of KEPT_AT_HQ whose base this is: values a just-created app holds at HQ's own default, which
        # a reading meets.
        "application-and-settings/34-hq-build-spec-at-or-above-nova-s-floor-2-57",
        "application-and-settings/build-profiles-each-profile-s-name-langs-practice-mobile-worker",
        "application-and-settings/target-derived-profile-properties-posturl-posttesturl-ota",
        "application-and-settings/amplifies-workers-amplifies-project-minimum-use-threshold",
        "application-and-settings/rev-domain-copy-of-version",
        "application-and-settings/built-with-build-signed-built-on-build-comment-comment-from-last",
        "application-and-settings/date-created-created-from-template-last-modified-has-submissions",
        "application-and-settings/copy-history-family-id",
        "application-and-settings/archived-media",
        "application-and-settings/id",
        "menus-and-case-lists/modulebase-unique-id",
        "forms-and-case-writes/unique-id",
        "forms-and-case-writes/version",
    ),
    vellum=((0, 0),),
    declaration=Declaration(runs_only_on=None),
)
