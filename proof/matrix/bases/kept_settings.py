"""``hq-kept-settings``: an app made in HQ that holds every value a project space keeps, each at a choice of its own.

1. A new app (``views/apps.py::default_new_app``), named "Clinic round"
   on the app page (``edit_app_attr``), in English and French on its
   Languages page (``views/apps.py::edit_app_langs``).
2. A survey menu "Rounds" (``views/modules.py::new_module``) whose form
   holds one text question ``note``, labelled in both languages, written by
   HQ's own form writer (``xform_builder.py::XFormBuilder``) and uploaded on
   the form page.
3. One save of the app settings page's ``hq`` settings
   (``views/settings.py::edit_commcare_settings``, which stores each through
   ``views/apps.py::edit_app_attr`` with ``all``): Web Apps on, secure
   submissions, location capture on every form, the mobile report version
   1.5, the persistent menu on, breadcrumbs off (HQ's own default is on,
   ``models/applications.py::Application.show_breadcrumbs``) and a custom
   base URL that is a second origin with a path, which ``edit_app_attr``
   takes always (``_always_allowed``) and whose origin alone reaches a
   build (``absolute_url_property``'s ``urljoin``).
4. The same page's profile saves (``views/settings.py::edit_commcare_profile``):
   each of the fifteen settings Nova seeds at a choice other than Nova's
   seed, "Log Case Detail Views" on, and the worker activity credential at
   three months.
5. The UI translations page (``views/apps.py::edit_app_ui_translations``):
   the runtime text ``home.start`` in each language, ``home.sync`` in French
   alone (so HQ's build writes its own catalog text for it in English,
   ``app_strings.py::SelectKnownAppStrings.app_strings_parts``: HQ holds an
   English catalog, ``messages_en-2.txt``, and no French one), and a display
   name for French and none for English.
6. A logo on the Android home and sign-in slots, each uploaded through the
   settings page's logo uploader (``hqmedia/views.py::ProcessLogoFileUploadView``),
   the lane's stand-in picture each (``proof/matrix/media.py::stand_in``).
7. Two values no page of HQ's offers here, set with HQ's model: the location
   list setting ``both_fixtures`` (the settings page offers it only under
   ``HIERARCHICAL_LOCATION_FIXTURE``, ``commcare-app-settings.yml``), and a
   practice worker's id. The page stores a practice worker only for a
   project space whose plan holds practice mode
   (``edit_app_attr``: ``app.enable_practice_users``), and HQ's build then
   writes that worker's restore (``Application.create_practice_user_restore``),
   which the unit's project space does not hold; under a plan without it the
   app keeps the id and HQ's build reads nothing of it.

Its configuration is the lane's floor with ``CLOUDCARE`` (Web Apps lists the
app) and ``COMMCARE_LOGO_UPLOADER`` (HQ's build writes the logos into the
profile only under it, ``ApplicationBase.create_profile``). Web Apps is on and
the content runs on both platforms, so its preselected declaration is both,
which includes Android: every kept row whose archive cell mirrors the value
is then observed on an archive.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Clinic round"
LANGS = ("en", "fra")
CUSTOM_BASE_URL = "https://example.org/hq/"
# An id no worker of any project space holds, written as HQ writes a user's id.
PRACTICE_WORKER_ID = "5e77ab1e5e77ab1e5e77ab1e5e77ab1e"
# Each of the fifteen settings Nova seeds at one of its own choices other than Nova's seed
# (static/app_manager/json/commcare-profile-settings.yml), and the detail-view log on.
PROFILE_PROPERTIES = {
    "cc-autoup-freq": "freq-weekly",
    "cc-autosync-freq": "freq-daily",
    "cc-content-valid": "yes",
    "cc-days-form-retain": "31",
    "cc-enable-tts": "yes",
    "cc-fuzzy-search-enabled": "yes",
    "cc-gps-auto-capture-accuracy": "20",
    "cc-inflation-target-density": "240",
    "cc-label-required-questions-with-asterisk": "yes",
    "cc-log-entity-detail-enabled": True,
    "cc-login-duration-seconds": "28800",
    "cc-maps-default-layer": "terrain",
    "cc-resize-images": "half",
    "logenabled": "Disabled",
    "unsent-number-limit": "20",
    "unsent-time-limit": "14",
}
ATTRIBUTES = {
    "auto_gps_capture": True,
    "cloudcare_enabled": True,
    "custom_base_url": CUSTOM_BASE_URL,
    "mobile_ucr_restore_version": "1.5",
    "persistent_menu": True,
    "secure_submissions": True,
    "show_breadcrumbs": False,
}
UI_TRANSLATIONS = {
    "en": {"home.start": "Begin the round"},
    "fra": {"home.start": "Commencer la tournée", "home.sync": "Envoyer la tournée", "fra": "Langue de la tournée"},
}
ANDROID_LOGOS = ("hq_logo_android_home", "hq_logo_android_login")


def survey_source(name):
    """The survey, as HQ's ``XFormBuilder`` writes it: one text question labelled in both languages."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("note", {"en": "Note", "fra": "Remarque de la tournée"}, "string")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def _model_values(app):
    app.location_fixture_restore = "both_fixtures"
    app.practice_mobile_worker_id = PRACTICE_WORKER_ID


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.set_languages(authoring, app_id, LANGS)
    _pages.new_survey_module(authoring, app_id, name="Rounds")
    ops.upload_form_source(authoring, app_id, 0, 0, survey_source, "survey-source")
    _pages.save_settings(
        authoring, app_id, attributes=ATTRIBUTES, properties=PROFILE_PROPERTIES, features={"credentials": "3MON_ACTIVE"}
    )
    _pages.save_ui_translations(authoring, app_id, UI_TRANSLATIONS)
    for slot in ANDROID_LOGOS:
        _pages.upload_logo(authoring, app_id, slot)
    _pages.change_app_model(authoring, app_id, "kept-values", _model_values)
    return app_id


BASE = Base(
    id="hq-kept-settings",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "COMMCARE_LOGO_UPLOADER"})),
    exhibits=(
        "application-and-settings/40-hq-cloudcare-enabled",
        "questions/text-input-xsd-string",
        # The rows of KEPT_AT_HQ whose base this is (lib/commcare/surface/keptAtHq.ts).
        "application-and-settings/1-properties-cc-autoup-freq",
        "application-and-settings/4-properties-cc-days-form-retain",
        "application-and-settings/5-properties-logenabled",
        "application-and-settings/13-properties-cc-autosync-freq",
        "application-and-settings/17-properties-cc-content-valid",
        "application-and-settings/18-properties-unsent-number-limit",
        "application-and-settings/19-properties-unsent-time-limit",
        "application-and-settings/22-properties-cc-resize-images",
        "application-and-settings/25-properties-cc-login-duration-seconds",
        "application-and-settings/26-properties-cc-inflation-target-density",
        "application-and-settings/27-properties-cc-gps-auto-capture-accuracy",
        "application-and-settings/28-properties-cc-maps-default-layer",
        "application-and-settings/29-properties-cc-enable-tts",
        "application-and-settings/30-properties-cc-label-required-questions-with-asterisk",
        "application-and-settings/24-properties-cc-log-entity-detail-enabled",
        "application-and-settings/translations-key-in-a-runtime-s-ui-string-catalog-core-android",
        "application-and-settings/translations-catalog-key-hq-fills-with-its-own-text-in-a",
        "application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s",
        "application-and-settings/logo-refs-hq-logo-android-home-login-demo",
        "application-and-settings/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app",
        "application-and-settings/51-hq-persistent-menu",
        "application-and-settings/52-hq-show-breadcrumbs",
        "application-and-settings/36-hq-custom-base-url",
        "application-and-settings/35-hq-practice-mobile-worker-id",
        "application-and-settings/32-features-credentials",
        # Kept rows another base exhibits, which this one holds as well.
        "application-and-settings/23-properties-cc-fuzzy-search-enabled",
        "application-and-settings/43-hq-secure-submissions",
        "application-and-settings/49p-hq-mobile-ucr-restore-version-1-0-1-5",
        # The entry location-list-setting-reset reads.
        "application-and-settings/50p-hq-location-fixture-restore-both-fixtures-only-flat-fixture",
    ),
)
