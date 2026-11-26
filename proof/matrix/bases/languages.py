"""``hq-languages``: an app made in HQ in three languages, with the texts a person leaves blank or renames.

1. A new app (``views/apps.py::default_new_app``), named "Village round" on
   the app page (``edit_app_attr``), in English, French and Hindi on its
   Languages page (``views/apps.py::edit_app_langs``), English first.
2. A survey menu " Visits", its name typed with a space before it, which
   ``views/modules.py::new_module`` stores as posted and Nova writes without
   (``text-spaces-dropped``), whose form is
   written by HQ's own form writer (``xform_builder.py::XFormBuilder``) in all
   three languages, uploaded on the form page and saved in HQ's form builder
   after the build (``vellum``): a text question ``visitor`` and a single
   select ``village``, each text under the itext id the form writer gives it,
   which every language shares.
3. A second survey menu "Village notes" whose form is uploaded on the form
   page and never opened in the form builder, whose save fills a blank
   translation from the first language (``javaRosa/itext.js``,
   ``ItextForm.getValueOrDefault``): a text question ``remark`` whose label
   is under an itext id a person renamed (``remark_text``, as the form
   builder's Label Itext ID field writes one,
   ``javaRosa/itextWidget.js::iTextIDWidget``), and a text question ``crop``
   whose French label is blank while its English one is not
   (``blank-translations-filled``).
4. A text badge on the second menu, saved on its settings page.
5. Generated keys on the UI translations page
   (``views/apps.py::edit_app_ui_translations``), each held as stored:
   the first form's name in English, ``forms.m0f0``, at the text HQ's build
   writes for it, which Nova reads as the form's menu label's own wording,
   equal to the name; the second menu's name in French, ``modules.m1``,
   which the menu itself names in English alone, so the key is that menu
   title's own French wording (``translations-generated-wording``); the
   app name's two strings, ``app.display.name`` and ``homescreen.title``,
   alike in French (the app name's translation there,
   ``translations-app-display-name`` and ``translations-homescreen-title``),
   different in Hindi, and the home screen title alone in English (each
   the string's own wording); and ``forms.m9f0``, which names no string of
   the app (``translations-generated-key-with-no-effect``), so the first
   publish removes it (``unused-translation-keys-removed``). The page drops
   ``modules.m0`` from every save, so the menu override is on the second
   menu.

Its configuration is the lane's floor and the ``CUSTOM_ICON_BADGES`` privilege, without which HQ's settings
page saves no badge (``handle_custom_icon_edits``). Web Apps is off, as
``Application.cloudcare_enabled`` defaults, and its content runs on Android,
so its preselected declaration is Android only: an app of several languages
is read where an archive is made, which compares its app strings with HQ's
build's.
"""

from __future__ import annotations

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Village round"
# The first menu's name, posted with a space before it as a person can type one; HQ stores it as posted.
FIRST_MENU = " Visits"
LANGS = ("en", "fra", "hin")


def visit_source(name):
    """The first survey, as HQ's ``XFormBuilder`` writes it, in all three languages."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("visitor", {"en": "Visitor name", "fra": "Nom du visiteur", "hin": "आगंतुक का नाम"}, "string")
    xform.new_question(
        "village",
        {"en": "Which village", "fra": "Quel village", "hin": "कौन सा गाँव"},
        "select1",
        choices={"upper": "Upper", "lower": "Lower"},
    )
    return xform.tostring(xml_declaration=True).decode("utf-8")


def notes_source(name):
    """The second survey: ``XFormBuilder``'s ``remark`` and ``crop``, then the label itext id of ``remark``
    renamed in every language, as the form builder's Label Itext ID field renames it (the text's ``id`` and the
    label's ``jr:itext`` reference), and each language's texts in one translation. ``crop``'s French value is
    blank."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("remark", {"en": "Remark", "fra": "Remarque", "hin": "टिप्पणी"}, "string")
    xform.new_question("crop", {"en": "Crop grown", "fra": "", "hin": "उगाई गई फसल"}, "string")
    # The form writer makes the elements it adds with no namespace (``lxml.builder.E``), which the source
    # holds in the XForms namespace once written, so they are found by local name.
    root = xform._etree
    texts = root.xpath("//*[local-name()='text'][@id='remark-label']")
    labels = root.xpath("//*[local-name()='input'][@ref='/data/remark']/*[local-name()='label']")
    if len(texts) != len(LANGS) or len(labels) != 1:
        raise ValueError(f"The form writer wrote {len(texts)} texts and {len(labels)} labels for remark.")
    for text in texts:
        text.set("id", "remark_text")
    for label in labels:
        label.set("ref", "jr:itext('remark_text')")
    # The form writer finds a language's translation by its XForms name (``_append_to_translation``), which the
    # translations it adds do not hold while the form is in memory, so each question after the first gets a second
    # translation of each language but the first. Core refuses a form with two translations of one language
    # (``XFormParser.parseTranslation``), so each language's texts are put in its first translation, in order.
    first_of = {}
    for translation in root.xpath("//*[local-name()='itext']/*[local-name()='translation']"):
        lang = translation.get("lang")
        if lang not in first_of:
            first_of[lang] = translation
            continue
        for text in list(translation):
            first_of[lang].append(text)
        translation.getparent().remove(translation)
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.set_languages(authoring, app_id, LANGS)
    _pages.new_survey_module(authoring, app_id, name=FIRST_MENU)
    ops.upload_form_source(authoring, app_id, 0, 0, visit_source, "visit-source")
    _pages.new_survey_module(authoring, app_id, name="Village notes")
    ops.upload_form_source(authoring, app_id, 1, 0, notes_source, "notes-source")
    _pages.save_module_attributes(
        authoring, app_id, 1, [("custom_icon_type", "text"), ("custom_icon_text_body", "New")], "badge"
    )
    _pages.save_ui_translations(
        authoring,
        app_id,
        {
            "en": {"forms.m0f0": "Survey", "homescreen.title": "Village survey home", "forms.m9f0": "Nowhere"},
            "fra": {
                "modules.m1": "Carnet du village",
                "app.display.name": "Enquête du village",
                "homescreen.title": "Enquête du village",
            },
            "hin": {"app.display.name": "Gaon sarvekshan", "homescreen.title": "Gaon ka ghar"},
        },
    )
    return app_id


BASE = Base(
    id="hq-languages",
    build=build,
    configuration=Configuration(privileges=frozenset({"CUSTOM_ICON_BADGES"})),
    exhibits=(
        "application-and-settings/langs-order-langs-0-default",
        "application-and-settings/langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin",
        "application-and-settings/translations-generated-wording",
        "application-and-settings/translations-generated-key-with-no-effect",
        "application-and-settings/translations-app-display-name",
        "application-and-settings/translations-homescreen-title",
        "questions/label-default-text-itext-value",
        "questions/an-explicitly-blank-value-in-a-non-default-language-where-the",
        "questions/itext-ids-other-than-a-pragma-key-default-placement",
        "questions/text-input-xsd-string",
        "questions/multiple-choice-select1-item",
        "menus-and-case-lists/custom-icons-0-badge-localized-text-or-xpath",
    ),
    vellum=((0, 0),),
)
