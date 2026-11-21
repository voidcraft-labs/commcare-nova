"""The named changes of variants whose entry is in the manifest area ``application-and-settings``.

Each makes its change through one of HQ's own views (``ops.post``), as a person's page does.
"""

from __future__ import annotations

from proof.matrix import ops

WEB_APPS_LOGO = "hq_logo_web_apps"


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
