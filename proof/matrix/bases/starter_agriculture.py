"""``starter-agriculture``: HQ's agriculture starter app, as HQ's template loader makes it, with stand-in media.

``views/apps.py::load_app_from_slug("agriculture")``'s calls but its last
(``_pages.from_template``): the app ``import_app_from_doc`` makes of
``static/app_manager/template_apps/agriculture/app.json``, marked
``created_from_template``, then each path of the template's
``multimedia.json`` mapped to the lane's stand-in picture
(``proof/matrix/media.py``), thirteen paths at HQ's own places. It holds
four menus and nine forms, Phone Number questions, a child case opened in a
repeat, six forms whose questions default to a value of the case
(``#case/`` defaults the form builder wrote; no ``case_preload`` entry), a
date sort descending with blanks last, ``translations.fra`` for a language
outside ``langs`` (UI keys CommCare HQ keeps, which no runtime reads for a
language the app does not hold), a Register action that goes on with the new
case, three ``case_list_form`` blocks with a blank form id (menus 0, 2 and 3),
list columns that show a property of the farmer's parent case
(``parent/name``), and two Hidden Values of 'Post-Harvest Visit'
(``standard_estimate_yield_rice`` and ``standard_estimate_yield_corn``) that
hold both a calculate and a default no later load-time value reads.

The template holds ``cloudcare_enabled: true``, and HQ's import sets the
setting from the plan (``models/applications.py::_create_app_from_doc``), so
its configuration holds ``CLOUDCARE``; its forms open a child case, which
HQ's Case Management page offers only under ``CHILD_CASES``
(``proof/checks/configurations.py::_needs_child_cases``). It is read under the
reading's preselected declaration.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

SLUG = "agriculture"


def build(authoring) -> str:
    return _pages.from_template(authoring, SLUG)


BASE = Base(
    id="starter-agriculture",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "CHILD_CASES"})),
    exhibits=(
        "application-and-settings/date-created-created-from-template-last-modified-has-submissions",
        "application-and-settings/multimedia-map",
        "menus-and-case-lists/put-in-root-display-only-forms",
        "menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module",
        "menus-and-case-lists/case-list-form-post-form-workflow-default-case-list",
        "menus-and-case-lists/case-list-form-fields-beside-a-blank-form-id",
        "menus-and-case-lists/direction",
        "menus-and-case-lists/blanks-first-last",
        "menus-and-case-lists/idx-prop-parent-host-any-index-names-other-than-a-first-step",
        "questions/phone-number-xsd-string-appearance-numeric",
        "questions/hidden-value-with-both-calculate-and-a-default-no-runtime-reads",
        "questions/setvalue-event-xforms-ready-default-on-a-question-outside",
        "expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
        "forms-and-case-writes/subcases-child-case-relationship-child-type-a-module-case-type",
        "forms-and-case-writes/subcases-repeat-context",
    ),
)
