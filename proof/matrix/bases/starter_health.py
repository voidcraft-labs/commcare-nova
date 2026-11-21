"""``starter-health``: HQ's health starter app, as HQ's template loader makes it, with stand-in media.

``views/apps.py::load_app_from_slug("health")``'s calls but its last
(``_pages.from_template``): the app ``import_app_from_doc`` makes of
``static/app_manager/template_apps/health/app.json``, marked
``created_from_template``, then each path of the template's
``multimedia.json`` mapped to the lane's stand-in file of its kind
(``proof/matrix/media.py``), ten paths at HQ's own places, six pictures and
four sounds. It holds two display-only menus (``put_in_root``), a Register
action that returns to the list with an icon, a case list filter, an
ascending sort with blanks last on a property no column of the list shows,
named "Feeling Sick" in Sort by, three case forms whose logic reads the
case, a ``case_list_form`` block with a blank form id on menu 2, profile
values Nova does not seed (``cc-fuzzy-search-enabled: yes`` among them),
``secure_submissions`` and ``mobile_ucr_restore_version`` 1.0.

The template holds ``cloudcare_enabled: true``, and HQ's import sets the
setting from the plan (``models/applications.py::_create_app_from_doc``), so
its configuration holds ``CLOUDCARE``, the one privilege its content needs
(``proof/checks/configurations.py::required_privileges``: no child case, no
lookup table, no link). It is read under the reading's preselected
declaration, which for an app with Web Apps on whose content runs on both
platforms is both platforms. HQ's import gives the app the project space's
default CommCare version, since it drops the template's ``build_spec``
(``_import_app``).
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

SLUG = "health"


def build(authoring) -> str:
    return _pages.from_template(authoring, SLUG)


BASE = Base(
    id="starter-health",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE"})),
    exhibits=(
        # The rows of KEPT_AT_HQ whose base this is.
        "application-and-settings/23-properties-cc-fuzzy-search-enabled",
        "application-and-settings/43-hq-secure-submissions",
        "application-and-settings/49p-hq-mobile-ucr-restore-version-1-0-1-5",
        "application-and-settings/multimedia-map",
        # What the template holds.
        "application-and-settings/date-created-created-from-template-last-modified-has-submissions",
        "menus-and-case-lists/put-in-root-display-only-forms",
        "menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module",
        "menus-and-case-lists/case-list-form-post-form-workflow-default-case-list",
        "menus-and-case-lists/case-list-form-media-image-media-audio",
        "menus-and-case-lists/case-list-form-fields-beside-a-blank-form-id",
        "menus-and-case-lists/detail-filter-value-lifts-into-predicate",
        "menus-and-case-lists/blanks-first-last",
        "menus-and-case-lists/direction",
        "menus-and-case-lists/display-lang-sort-by-label-on-a-sort-only-element",
        "expressions-and-data/case-prop-case-parent-prop-case-grandparent-prop",
        "expressions-and-data/selected",
        "menus-and-case-lists/media-image-media-audio-same-asset-in-every-language",
        "forms-and-case-writes/media-image-media-audio-same-asset-every-language",
        "questions/label-image-audio-video-same-asset-every-language",
        "forms-and-case-writes/open-case-name-update-question-path",
        "forms-and-case-writes/update-case-update-property-question",
    ),
)
