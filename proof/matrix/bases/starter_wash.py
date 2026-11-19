"""``starter-wash``: HQ's water and sanitation starter app, as HQ's template loader makes it, with stand-in media.

``views/apps.py::load_app_from_slug("wash")``'s calls but its last
(``_pages.from_template``): the app ``import_app_from_doc`` makes of
``static/app_manager/template_apps/wash/app.json``, marked
``created_from_template``, then each path of the template's
``multimedia.json`` mapped to the lane's stand-in picture
(``proof/matrix/media.py``) at ``MULTIMEDIA_PREFIX + path``, as the loader
maps it. That file names seven paths, and one of them is an address where a
path belongs (``https://cdn2.hubspot.net/.../wash/module2_form0_en.png``,
whose address is the picture for ``commcare/image/module1_form0_en.png``), so
an app HQ makes from the template maps a file at a path nothing references
and holds no file for the first menu's first form's icon, whose map entry
names the template's own multimedia id; the base keeps both, as the loader
leaves them. It holds four display-only menus beside one with a case list,
three forms that open a child case, three ``case_list_form`` blocks with a
blank form id (menus 2, 3 and 4; menu 0 holds none), a case detail column
that shows the parent case's ``full_address`` (a related column, which
``starter-agriculture`` exhibits on a list a value expectation reads), and the
Hidden Value ``client_status`` of 'Restore or Interrupt Water Supply', which
holds both a calculate and a default no later load-time value reads.

The template holds ``cloudcare_enabled: true``, and HQ's import sets the
setting from the plan (``models/applications.py::_create_app_from_doc``), so
its configuration holds ``CLOUDCARE``; its forms open child cases, which HQ's
Case Management page offers only under ``CHILD_CASES``
(``proof/checks/configurations.py::_needs_child_cases``). It is read under the
reading's preselected declaration. ``template_apps/wash_before_cond_case_update``
is no base: its content is this one's, and its map names files no project
space holds.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

SLUG = "wash"


def build(authoring) -> str:
    return _pages.from_template(authoring, SLUG)


BASE = Base(
    id="starter-wash",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "CHILD_CASES"})),
    exhibits=(
        "application-and-settings/date-created-created-from-template-last-modified-has-submissions",
        "application-and-settings/multimedia-map",
        "menus-and-case-lists/put-in-root-display-only-forms",
        "menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module",
        "menus-and-case-lists/case-list-form-post-form-workflow-default-case-list",
        "menus-and-case-lists/case-list-form-fields-beside-a-blank-form-id",
        "questions/setvalue-event-xforms-ready-default-on-a-question-outside",
        "questions/hidden-value-with-both-calculate-and-a-default-no-runtime-reads",
        "expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
        "forms-and-case-writes/subcases-child-case-relationship-child-type-a-module-case-type",
    ),
)
