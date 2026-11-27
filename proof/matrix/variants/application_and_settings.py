"""The named changes of variants whose entry is in the manifest area ``application-and-settings``.

Each makes its change through one of HQ's own views (``ops.post``), as a person's page does.
"""

from __future__ import annotations

from proof.matrix import ops

WEB_APPS_LOGO = "hq_logo_web_apps"


def menu_icon_override_with_only_a_map_entry(authoring, app_id):
    _menu_icon_override_with_form_carrier(authoring, app_id, None)


def menu_icon_override_with_carrier_in_another_language(authoring, app_id):
    _menu_icon_override_with_form_carrier(authoring, app_id, "fr")


def menu_icon_override_with_carrier_outside_named_profile(authoring, app_id):
    _menu_icon_override_with_form_carrier(authoring, app_id, "fr")
    ops.set_json(authoring, app_id, "/build_profiles", {
        "english": {"doc_type": "BuildProfile", "name": "English", "langs": ["en"]},
    })


def _menu_icon_override_with_form_carrier(authoring, app_id, carrier_language):
    """Same mapped icon and English locale value, with or without a French form carrier."""
    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations

    path = "jr://file/commcare/image/data/animal_name.png"

    def remove_picture(root, _form):
        media = [
            value for value in root.iter("{http://www.w3.org/2002/xforms}value")
            if value.get("form") == "image" and value.text == path
        ]
        assert len(media) == 1
        media[0].getparent().remove(media[0])

    ops.set_form_source(authoring, app_id, 0, 0, remove_picture, what="remove the ordinary picture carrier")
    if carrier_language is not None:
        ops.set_json(authoring, app_id, "/langs", ["en", carrier_language])
        ops.set_json(authoring, app_id, "/modules/0/forms/0/media_image", {carrier_language: path})
    key = "modules.m0.icon"
    ops.set_json(authoring, app_id, "/translations", {"en": {key: path}})
    with authoring.step("variant:mapped-menu-icon-source"):
        app = operations.held_app(authoring.state, app_id)
        assert app.multimedia_map[path].media_type == "CommCareImage"
        assert app.modules[0].uses_image()
        assert parse_app_strings(app.create_app_strings("en"))[key] == path
        assert path not in app.all_media_paths(lang="en")
        assert (path in app.all_media_paths()) == (carrier_language is not None)


def menu_audio_override_with_only_a_map_entry(authoring, app_id):
    """A spoken menu title points at a mapped recording no ordinary carrier keeps."""
    from proof.hq import operations

    path = "jr://file/commcare/audio/data/animal_name.mp3"

    def remove_recording(root, _form):
        recording, = (
            value for value in root.iter("{http://www.w3.org/2002/xforms}value")
            if value.get("form") == "audio" and value.text == path
        )
        recording.getparent().remove(recording)

    ops.set_form_source(authoring, app_id, 0, 0, remove_recording, what="remove the ordinary audio carrier")
    ops.set_json(authoring, app_id, "/translations", {"en": {"modules.m0.audio": path}})
    app = operations.held_app(authoring.state, app_id)
    assert app.multimedia_map[path].media_type == "CommCareAudio"
    assert path not in app.all_media_paths()


def translation_overrides_a_detail_tab_title(authoring, app_id):
    """The Case Detail editor changes the tab's ordinary header independently of the generated override."""
    import json

    from proof.hq import operations
    from proof.checks.compare.app_strings import parse_app_strings

    key = "m0.case_long.tab.1.title"
    tabs = [
        {"doc_type": "DetailTab", "header": {"en": "Patient"}, "starting_index": 0, "has_nodeset": False},
        {"doc_type": "DetailTab", "header": {"en": "More"}, "starting_index": 3, "has_nodeset": False},
    ]

    def save_tabs():
        module = operations.held_app(authoring.state, app_id).get_module(0)
        body, content_type = ops.form_body([
            ("type", json.dumps("case")),
            ("long", json.dumps([column.to_json() for column in module.case_details.long.columns])),
            ("tabs", json.dumps(tabs)),
        ])
        ops.post(authoring, "edit_module_detail_screens", [app_id, module.unique_id], body, content_type, "Case Detail tabs")

    with authoring.step("variant:plain-detail-tab-title"):
        save_tabs()
        app = operations.held_app(authoring.state, app_id)
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Patient"
    ops.set_json(authoring, app_id, f"/translations/en/{key}", "Patient details")
    tabs[0]["header"]["en"] = "Patient record"
    with authoring.step("variant:edited-detail-tab-header-with-override"):
        save_tabs()
        app = operations.held_app(authoring.state, app_id)
        assert app.get_module(0).case_details.long.tabs[0].header["en"] == "Patient record"
        assert app.translations["en"][key] == "Patient details"
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Patient details"


def translation_overrides_a_menu_badge(authoring, app_id):
    """The native menu uses its badge locale independently of the text stored on the icon."""
    from lxml import etree

    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations

    key = "modules.m2.badge"
    ops.set_json(authoring, app_id, "/modules/2/custom_icons", [
        {"doc_type": "CustomIcon", "form": "badge", "text": {"en": "New"}, "xpath": ""},
    ])
    with authoring.step("variant:plain-menu-badge"):
        app = operations.held_app(authoring.state, app_id)
        assert parse_app_strings(app.create_app_strings("en"))[key] == "New"
        suite = etree.fromstring(app.create_suite())
        assert suite.xpath(f"//menu/display/text[@form='badge']/locale[@id='{key}']")
    translations = dict(app.translations)
    translations["en"] = {**translations.get("en", {}), key: "Urgent"}
    ops.set_json(authoring, app_id, "/translations", translations)
    with authoring.step("variant:overridden-menu-badge"):
        app = operations.held_app(authoring.state, app_id)
        assert app.get_module(2).custom_icons[0].text["en"] == "New"
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Urgent"


def translation_overrides_a_form_badge(authoring, app_id):
    """A command badge also reads its own effective generated locale."""
    from lxml import etree

    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations

    key = "forms.m2f0.badge"
    ops.set_json(authoring, app_id, "/modules/2/forms/0/custom_icons", [
        {"doc_type": "CustomIcon", "form": "badge", "text": {"en": "New"}, "xpath": ""},
    ])
    with authoring.step("variant:plain-form-badge"):
        app = operations.held_app(authoring.state, app_id)
        assert parse_app_strings(app.create_app_strings("en"))[key] == "New"
        suite = etree.fromstring(app.create_suite())
        assert suite.xpath(f"//command/display/text[@form='badge']/locale[@id='{key}']")
    translations = dict(app.translations)
    translations["en"] = {**translations.get("en", {}), key: "Urgent"}
    ops.set_json(authoring, app_id, "/translations", translations)
    with authoring.step("variant:overridden-form-badge"):
        app = operations.held_app(authoring.state, app_id)
        assert app.get_module(2).get_form(0).custom_icons[0].text["en"] == "New"
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Urgent"


def translation_overrides_a_lookup_heading(authoring, app_id):
    """Lookup Results uses a separate generated heading beside the configured label."""
    from lxml import etree

    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations
    from proof.matrix.variants.menus_and_case_lists import fixed_text_callout_with_confidence

    key = "case_lists.m0.callout.header"
    fixed_text_callout_with_confidence(authoring, app_id)
    with authoring.step("variant:plain-lookup-heading"):
        app = operations.held_app(authoring.state, app_id)
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Confidence"
        assert etree.fromstring(app.create_suite()).xpath(f"//header/text/locale[@id='{key}']")
    translations = dict(app.translations)
    translations["en"] = {**translations.get("en", {}), key: "Match score"}
    ops.set_json(authoring, app_id, "/translations", translations)
    with authoring.step("variant:overridden-lookup-heading"):
        app = operations.held_app(authoring.state, app_id)
        assert app.get_module(0).case_details.short.lookup_field_header["en"] == "Confidence"
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Match score"


def translation_overrides_a_search_group_heading(authoring, app_id):
    """A grouped Search heading has native generated wording of its own."""
    _translation_overrides_a_search_group_heading(authoring, app_id, "group_header_0")


def translation_overrides_a_saved_legacy_search_group_heading(authoring, app_id):
    """The live legacy group key in hq-search/grouped-fields still owns its native heading."""
    _translation_overrides_a_search_group_heading(authoring, app_id, "g")


def translation_competes_with_a_saved_legacy_search_group_heading(authoring, app_id):
    """The old active heading also has separate wording stored under its dormant current key."""
    translation_overrides_a_saved_legacy_search_group_heading(authoring, app_id)
    with authoring.step("variant:dormant-canonical-heading-wording"):
        ops.upload_commcare_translation(authoring.state, app_id, "search_property.m0.group_header_0", "Other saved words")


def translation_competes_with_a_legacy_heading_in_two_languages(authoring, app_id):
    """A competing key with a second build language needs its own fallback evidence."""
    translation_competes_with_a_saved_legacy_search_group_heading(authoring, app_id)
    ops.set_json(authoring, app_id, "/langs", ["en", "es"])
    ops.set_json(authoring, app_id, "/build_langs", ["en", "es"])


def a_legacy_search_group_competes_with_a_second_language_override(authoring, app_id):
    """The dormant key has separate words in the second build language."""
    from proof.hq import operations

    translation_competes_with_a_legacy_heading_in_two_languages(authoring, app_id)
    app = operations.held_app(authoring.state, app_id)
    translations = dict(app.translations)
    translations["es"] = {
        **translations.get("es", {}),
        "search_property.m0.group_header_0": "Otros datos",
    }
    ops.set_json(authoring, app_id, "/translations", translations)


def translation_duplicates_a_saved_legacy_search_group_heading(authoring, app_id):
    """The live heading and its dormant current key store the same wording."""
    translation_overrides_a_saved_legacy_search_group_heading(authoring, app_id)
    with authoring.step("variant:duplicate-canonical-heading-wording"):
        ops.upload_commcare_translation(authoring.state, app_id, "search_property.m0.group_header_0", "Find a client")


def _translation_overrides_a_search_group_heading(authoring, app_id, group):
    from lxml import etree

    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations
    from proof.matrix.variants.case_search import _grouped_search_rows

    key = f"search_property.m0.{group}"
    ops.set_json(authoring, app_id, "/modules/0/search_config/properties", _grouped_search_rows(authoring, app_id, "Local details", key=group))
    with authoring.step("variant:plain-search-group-heading"):
        app = operations.held_app(authoring.state, app_id)
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Local details"
        assert etree.fromstring(app.create_suite()).xpath(f"//group/display/text/locale[@id='{key}']")
    with authoring.step("variant:upload-search-group-heading"):
        ops.upload_commcare_translation(authoring.state, app_id, key, "Find a client")
    with authoring.step("variant:overridden-search-group-heading"):
        app = operations.held_app(authoring.state, app_id)
        assert app.get_module(0).search_config.properties[0].label["en"] == "Local details"
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Find a client"


def every_form_deleted(authoring, app_id):
    """The first menu's case list offered as a menu item of its own (``case_list``, shown, labelled), and then each
    of its forms deleted through the form's own delete (``views/forms.py::delete_form``), which takes the form out
    of its menu and keeps its source among the app's attachments for the undo (``Application.delete_form`` saves a
    ``DeleteFormRecord`` and removes no attachment), so HQ's source read serves sources no form of the app names.
    The menu item keeps the menu one a worker opens with no form in it."""
    from proof.hq import operations

    ops.set_json(authoring, app_id, "/modules/0/case_list/show", True)
    ops.set_json(authoring, app_id, "/modules/0/case_list/label", {"en": "Browse cases"})
    with authoring.step("variant:every-form-deleted"):
        module = operations.held_app(authoring.state, app_id).get_module(0)
        forms = [form.unique_id for form in module.get_forms()]
        for form in forms:
            body, content_type = ops.form_body([])
            ops.post(
                authoring,
                "delete_form",
                [app_id, module.unique_id, form],
                body,
                content_type,
                f"the deletion of form {form}",
                redirects=True,
            )


def web_apps_logo(authoring, app_id):
    """The lane's stand-in picture uploaded to the Web Apps logo slot through the settings page's logo uploader
    (``hqmedia/views.py::ProcessLogoFileUploadView``, which maps it at
    ``jr://file/commcare/logo/data/hq_logo_web_apps.png`` and names that path in ``logo_refs``)."""
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

    from proof.matrix import media

    path = f"jr://file/commcare/logo/data/{WEB_APPS_LOGO}.png"
    with authoring.step(f"variant:web-apps-logo:{path}", path.encode()):
        body = encode_multipart(
            BOUNDARY,
            {"Filedata": SimpleUploadedFile(f"{WEB_APPS_LOGO}.png", media.stand_in(path), content_type="image/png")},
        )
        ops.post(
            authoring, "hqmedia_uploader_logo", [app_id, WEB_APPS_LOGO], body, MULTIPART_CONTENT, f"the logo at {path}"
        )


# A suite the settings page's Custom Suite field holds, which no build of the app reads while it builds its own.
CUSTOM_SUITE = '<?xml version="1.0" encoding="UTF-8"?>\n<suite version="1"/>\n'


def custom_suite_kept_unused(authoring, app_id):
    """A custom suite stored as the app's ``custom_suite.xml`` attachment, as the settings page's Custom Suite field
    stores it (``views/apps.py::edit_commcare_settings`` calls ``Application.set_custom_suite``), the app still
    building its own suite (``use_custom_suite`` is false). HQ's source read serves it among the attachments
    (``Application.export_json``, ``get_attachments``)."""
    from proof.hq import operations

    with authoring.step("variant:custom-suite", CUSTOM_SUITE.encode()):
        operations.held_app(authoring.state, app_id).set_custom_suite(CUSTOM_SUITE)


def choose_grid_first_menu(authoring, app_id):
    from proof.matrix.bases import _pages

    _pages.save_settings(authoring, app_id, attributes={"use_grid_menus": True})


def choose_grid_form_menus(authoring, app_id):
    from proof.matrix.bases import _pages

    _pages.save_settings(authoring, app_id, attributes={"grid_form_menus": "all"})
