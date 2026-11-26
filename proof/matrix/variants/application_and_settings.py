"""The named changes of variants whose entry is in the manifest area ``application-and-settings``.

Each makes its change through one of HQ's own views (``ops.post``), as a person's page does.
"""

from __future__ import annotations

from proof.matrix import ops

WEB_APPS_LOGO = "hq_logo_web_apps"


def menu_icon_override_without_a_resource(authoring, app_id):
    """Keep the mapped icon and locale value, but remove its ordinary form carrier."""
    path = "jr://file/commcare/image/data/animal_name.png"

    def remove_picture(root, _form):
        media = [
            value for value in root.iter("{http://www.w3.org/2002/xforms}value")
            if value.get("form") == "image" and value.text == path
        ]
        assert len(media) == 1
        media[0].getparent().remove(media[0])

    ops.set_form_source(authoring, app_id, 0, 0, remove_picture, what="remove the ordinary picture carrier")
    ops.set_json(authoring, app_id, "/translations", {"en": {"modules.m0.icon": path}})


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


def upload_commcare_translation(state, app_id, key, value, *, language="en"):
    """Edit HQ's own Bulk CommCare Translations workbook and upload it through HQ's save view."""
    import io

    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart
    from django.urls import resolve, reverse
    from openpyxl import load_workbook

    from proof.hq import operations, requests

    def downloadable():
        path = reverse("download_bulk_ui_translations", args=[state.domain, app_id])
        view = resolve(path)
        with requests.held_get(state, path) as request:
            response = view.func(request, *view.args, **view.kwargs)
            assert response.status_code == 200, response.status_code
            content = b"".join(response.streaming_content) if response.streaming else response.content
        return load_workbook(io.BytesIO(content))

    download = downloadable()
    sheet = download["translations"]
    languages = [cell.value for cell in sheet[1][1:]]
    current = operations.held_app(state, app_id).translations
    expected = {code: dict(values) for code, values in current.items() if values}
    expected.setdefault(language, {})[key] = value
    # Keep the workbook and version metadata HQ downloaded. Upload only the
    # edited and explicitly saved rows so stock defaults do not become edits.
    sheet.delete_rows(2, sheet.max_row - 1)
    for prop in sorted({prop for values in expected.values() for prop in values}):
        sheet.append([prop, *(expected.get(code, {}).get(prop) for code in languages)])
    output = io.BytesIO()
    download.save(output)
    path = reverse("upload_bulk_ui_translations", args=[state.domain, app_id])
    body = encode_multipart(
        BOUNDARY, {"bulk_upload_file": SimpleUploadedFile("translations.xlsx", output.getvalue())},
    )
    view = resolve(path)
    request = requests.raw_post(state, path, body, MULTIPART_CONTENT)
    response = view.func(request, *view.args, **view.kwargs)
    assert response.status_code == 302, response.status_code
    messages = requests.messages(request)
    actual = operations.held_app(state, app_id).translations
    assert {code: dict(values) for code, values in actual.items() if values} == expected, messages
    after = downloadable()["translations"]
    column = languages.index(language) + 1
    [recorded] = [row[column].value for row in after.iter_rows() if row[0].value == key]
    assert recorded == value, messages
    return messages


def translation_overrides_a_search_group_heading(authoring, app_id):
    """A grouped Search heading has native generated wording of its own."""
    from lxml import etree

    from proof.checks.compare.app_strings import parse_app_strings
    from proof.hq import operations
    from proof.matrix.variants.case_search import _grouped_search_rows

    key = "search_property.m0.group_header_0"
    ops.set_json(authoring, app_id, "/modules/0/search_config/properties", _grouped_search_rows(authoring, app_id, "Local details"))
    with authoring.step("variant:plain-search-group-heading"):
        app = operations.held_app(authoring.state, app_id)
        assert parse_app_strings(app.create_app_strings("en"))[key] == "Local details"
        assert etree.fromstring(app.create_suite()).xpath(f"//group/display/text/locale[@id='{key}']")
    with authoring.step("variant:upload-search-group-heading"):
        upload_commcare_translation(authoring.state, app_id, key, "Find a client")
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
