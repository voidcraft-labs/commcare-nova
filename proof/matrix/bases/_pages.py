"""What the bases' builders post to HQ's app-manager pages, each as the page posts it.

Each helper opens its own operation (``build:<what>``) through the
``Authoring`` it is handed and posts through ``proof.matrix.ops.post``, so
HQ's URLconf, decorators and view answer it.

- ``new_app``: ``views/apps.py::default_new_app``, the dashboard's New
  Application, whose redirect names the app it made;
- ``rename_app``: the app's name as the app page's inline editor posts it to
  ``views/apps.py::edit_app_attr`` (``app_view.html``: ``name``);
- ``turn_web_apps_on``: ``cloudcare_enabled`` saved as the app settings page
  saves it (``proof/observe/hqside.py::app_attributes``, through
  ``views/settings.py::edit_commcare_settings`` and ``edit_app_attr`` with
  ``all``);
- ``new_case_module``: ``views/modules.py::new_module`` with ``module_type``
  ``case``, which adds a Registration Form and a Followup Form;
- ``save_case_actions``: a form's case management as the Case Management tab
  posts it (``views/forms.py::edit_form_actions``: the actions HQ holds in the
  tab's shape, ``form_action_diff.py::make_multi``, and the mappings as a
  ``case_mapping_diff``);
- ``save_case_list`` and ``save_case_detail``: a menu's case list (its
  columns and sort rules) and its case detail as the Case List and Case
  Detail tabs post them (``views/modules.py::edit_module_detail_screens``,
  ``details/bootstrap3/screen.js::serialize``: every value JSON).
"""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from proof.matrix import ops


def new_app(authoring) -> str:
    """A new blank app, made as the dashboard's New Application makes it. Returns its id."""
    from django.urls import resolve

    with authoring.step("build:new-app"):
        response = ops.post(authoring, "default_new_app", [], b"", ops.FORM_CONTENT_TYPE, "a new app", redirects=True)
    return resolve(urlsplit(response["Location"]).path).kwargs["app_id"]


def rename_app(authoring, app_id, name):
    with authoring.step("build:app-name", name.encode()):
        body, content_type = ops.form_body([("name", name)])
        ops.post(authoring, "edit_app_attr", [app_id, "name"], body, content_type, "the app's name")


def turn_web_apps_on(authoring, app_id):
    from proof.observe import hqside

    with authoring.step("build:web-apps-on"):
        hqside.app_attributes(authoring.state, app_id, {"cloudcare_enabled": True})


def new_case_module(authoring, app_id, *, name=None, case_type=None):
    """A case list menu, as the add menu's Case List posts it; ``name`` and ``case_type`` posted where given."""
    pairs = [("module_type", "case")]
    if name is not None:
        pairs.append(("name", name))
    if case_type is not None:
        pairs.append(("case_type", case_type))
    with authoring.step("build:new-module", json.dumps(pairs).encode()):
        body, content_type = ops.form_body(pairs)
        ops.post(authoring, "new_module", [app_id], body, content_type, "a new case list menu", redirects=True)


def save_case_actions(authoring, app_id, menu, form, *, name_path=None, updates=None):
    """The form's case management saved as the Case Management tab saves it: the case's name from ``name_path``
    where given, and each ``{property: question path}`` of ``updates`` saved to the case, every one always."""
    from corehq.apps.app_manager.form_action_diff import make_multi

    from proof.hq import operations

    diff = {}
    if name_path is not None:
        diff["open_case"] = {"add": [{"question_path": name_path, "update_mode": "always"}]}
    if updates:
        diff["update_case"] = {
            "add": {prop: [{"question_path": path, "update_mode": "always"}] for prop, path in sorted(updates.items())}
        }
    with authoring.step(f"build:case-actions:{menu}.{form}", json.dumps(diff, sort_keys=True).encode()):
        held = operations.held_app(authoring.state, app_id).get_module(menu).get_form(form)
        body, content_type = ops.form_body(
            [("actions", json.dumps(make_multi(held.actions.to_json()))), ("case_mapping_diff", json.dumps(diff))]
        )
        ops.post(
            authoring,
            "edit_form_actions",
            [app_id, held.unique_id],
            body,
            content_type,
            f"the case management of form {menu}.{form}",
        )


def column(field, header, *, format="plain", lang="en"):
    """A case list or case detail column as HQ's model writes it (``models/case_list.py::DetailColumn``), which the
    tabs post back as they hold it."""
    from corehq.apps.app_manager.models import DetailColumn

    return DetailColumn(model="case", field=field, header={lang: header}, format=format).to_json()


def save_case_list(authoring, app_id, menu, *, columns, sort_elements=()):
    """The menu's case list saved as the Case List tab saves it: ``type`` ``case``, its columns, its sort rules
    (``{field, type, direction, blanks, display, sort_calculation}`` each), and its list's own settings."""
    from proof.hq import operations

    with authoring.step(f"build:case-list:{menu}", json.dumps([columns, list(sort_elements)]).encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body(
            [
                ("type", json.dumps("case")),
                ("short", json.dumps(list(columns))),
                ("sort_elements", json.dumps(list(sort_elements))),
                ("multi_select", json.dumps(False)),
                ("auto_select", json.dumps(False)),
            ]
        )
        ops.post(
            authoring,
            "edit_module_detail_screens",
            [app_id, module.unique_id],
            body,
            content_type,
            f"the case list of menu {menu}",
        )


def save_case_detail(authoring, app_id, menu, *, columns):
    """The menu's case detail saved as the Case Detail tab saves it: ``type`` ``case``, its columns and no tab."""
    from proof.hq import operations

    with authoring.step(f"build:case-detail:{menu}", json.dumps(columns).encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body(
            [("type", json.dumps("case")), ("long", json.dumps(list(columns))), ("tabs", json.dumps([]))]
        )
        ops.post(
            authoring,
            "edit_module_detail_screens",
            [app_id, module.unique_id],
            body,
            content_type,
            f"the case detail of menu {menu}",
        )


def _attach_as_the_loader_does(state, app, data, path):
    """``data`` attached at ``path`` (the full ``jr://file/`` path) with the calls
    ``views/apps.py::load_app_from_slug`` makes for a template's fetched file:
    ``CommCareMultimedia.get_class_by_data``, ``get_by_data``,
    ``attach_data(data, original_filename=<the path's last segment>, username=...)``,
    ``add_domain(domain, owner=True)`` and ``app.create_mapping(multimedia, path)``, which saves the app. The
    loader skips a file HQ classifies as no image, audio or video; a stand-in HQ so reads is one the lane made
    wrongly, so it refuses by name."""
    import posixpath

    from corehq.apps.hqmedia.models import CommCareMultimedia

    from proof.matrix.ops import MatrixChangeRefused

    media_class = CommCareMultimedia.get_class_by_data(data)
    if media_class is None:
        raise MatrixChangeRefused(
            f"CommCare HQ reads the lane's file for {path} as no image, audio or video"
            " (CommCareMultimedia.get_class_by_data), so the template loader would skip it. The file is"
            " proof/matrix/media.py's stand-in; look at what it makes for that kind."
        )
    multimedia = media_class.get_by_data(data)
    multimedia.attach_data(data, original_filename=posixpath.basename(path), username=state.web_user.username)
    multimedia.add_domain(state.domain, owner=True)
    app.create_mapping(multimedia, path)


def from_template(authoring, slug) -> str:
    """An app made from HQ's template app ``slug`` as ``views/apps.py::load_app_from_slug`` makes one, in one
    operation (``build:template:<slug>``): ``import_app_from_doc(_load_app_template(slug), domain,
    {"created_from_template": slug})``, then, for each path of the template's ``multimedia.json`` in the file's
    order, the lane's stand-in for ``MULTIMEDIA_PREFIX + path`` (``proof/matrix/media.py::stand_in``) attached
    with the loader's calls where the loader attaches the file it fetched. The loader's last call,
    ``_build_sample_app`` (a build of the new app, released), is not made: nothing Nova reads of an app is a
    released copy of it, and the unit builds A itself. ``_load_app_template`` is memoized and the import wraps the
    document it is handed, so the import is handed a copy of the template file's document, which is what the
    loader's first call in a process is handed. Returns the app's id."""
    import copy
    import json
    import os

    from corehq.apps.app_manager.models import import_app_from_doc
    from corehq.apps.app_manager.views.apps import _app_template_dir, _load_app_template
    from corehq.apps.hqmedia.models import MULTIMEDIA_PREFIX

    from proof.matrix import media

    state = authoring.state
    with authoring.step(f"build:template:{slug}"):
        app = import_app_from_doc(
            copy.deepcopy(_load_app_template(slug)), state.domain, {"created_from_template": "%s" % slug}
        )
        multimedia_filename = os.path.join(_app_template_dir(slug), "multimedia.json")
        if os.path.exists(multimedia_filename):
            with open(multimedia_filename, encoding="utf-8") as handle:
                path_url_map = json.load(handle)
            for path in path_url_map:
                full_path = MULTIMEDIA_PREFIX + path
                _attach_as_the_loader_does(state, app, media.stand_in(full_path), full_path)
    return app._id


def attach_file(authoring, app_id, path, data, *, label="build"):
    """``data`` attached at ``path`` with the calls HQ's template loader makes for a file, in the operation
    ``<label>:media:<path>`` (``variant`` for a variant's own file). HQ raising while it stores the file (an image
    Pillow cannot open, ``CommCareImage.attach_data``) propagates, for a variant's row to hold."""
    import hashlib

    from proof.hq import operations

    with authoring.step(f"{label}:media:{path}", path.encode() + b"\n" + hashlib.sha256(data).digest()):
        app = operations.held_app(authoring.state, app_id)
        _attach_as_the_loader_does(authoring.state, app, data, path)


def attach_media(authoring, app_id, path, *, like=None):
    """The lane's stand-in file for ``path`` (or, with ``like``, the stand-in made for that other path, so one
    file is mapped at two paths) attached at ``path`` with the calls HQ's template loader makes for a file, in
    the operation ``build:media:<path>``."""
    from proof.hq import operations
    from proof.matrix import media

    with authoring.step(f"build:media:{path}", f"{path}\n{like or path}".encode()):
        app = operations.held_app(authoring.state, app_id)
        _attach_as_the_loader_does(authoring.state, app, media.stand_in(like or path), path)


def new_survey_module(authoring, app_id, *, name):
    """A survey menu named ``name``, as the add menu's Survey posts it (``views/modules.py::new_module`` with
    ``module_type`` ``survey``), which adds one form, "Survey"."""
    pairs = [("module_type", "survey"), ("name", name)]
    with authoring.step("build:new-survey-module", json.dumps(pairs).encode()):
        body, content_type = ops.form_body(pairs)
        ops.post(authoring, "new_module", [app_id], body, content_type, "a new survey menu", redirects=True)


def save_menu_media(authoring, app_id, menu, *, image=None, audio=None):
    """A menu's icon and audio label chosen on its settings page, each posted as the page's media picker posts
    it (``views/modules.py::edit_module_attr`` with the attribute ``media_image`` or ``media_audio``, through
    ``views/media_utils.py::handle_media_edits``, which sets the path for the app's language)."""
    from proof.hq import operations

    for attribute, path in (("media_image", image), ("media_audio", audio)):
        if path is None:
            continue
        with authoring.step(f"build:menu-media:{menu}:{attribute}", path.encode()):
            module = operations.held_app(authoring.state, app_id).get_module(menu)
            body, content_type = ops.form_body([(attribute, path)])
            ops.post(
                authoring,
                "edit_module_attr",
                [app_id, module.unique_id, attribute],
                body,
                content_type,
                f"the {attribute} of menu {menu}",
            )


def save_form_media(authoring, app_id, menu, form, *, image=None, audio=None):
    """A form's icon and audio label chosen on its settings page, each posted as the page's media picker posts
    it (``views/forms.py::edit_form_attr``, through ``views/media_utils.py::handle_media_edits``)."""
    from proof.hq import operations

    for attribute, path in (("media_image", image), ("media_audio", audio)):
        if path is None:
            continue
        with authoring.step(f"build:form-media:{menu}.{form}:{attribute}", path.encode()):
            held = operations.held_app(authoring.state, app_id).get_module(menu).get_form(form)
            body, content_type = ops.form_body([(attribute, path)])
            ops.post(
                authoring,
                "edit_form_attr",
                [app_id, held.unique_id, attribute],
                body,
                content_type,
                f"the {attribute} of form {menu}.{form}",
            )


def set_languages(authoring, app_id, langs, *, renames=None):
    """The app's languages saved on its Languages page (``views/apps.py::edit_app_langs``), as
    ``supported_languages.js``' save posts them: every code in order, ``rename`` naming each language the page
    loaded under its own code (a language added there has none), and ``smart_lang_display`` as the page holds it,
    which is the app's own value (``views/apps.py::get_app_view_context``: ``smart_lang_display_enabled``)."""
    from proof.hq import operations

    renames = renames or {}
    key = json.dumps({"langs": list(langs), "rename": renames}).encode() if renames else json.dumps(list(langs)).encode()
    with authoring.step("build:languages", key):
        app = operations.held_app(authoring.state, app_id)
        body, content_type = ops.json_body(
            {
                "langs": list(langs),
                "rename": {lang: renames.get(lang, lang) for lang in app.langs if renames.get(lang, lang) in langs},
                "smart_lang_display": getattr(app, "smart_lang_display", None),
            }
        )
        ops.post(authoring, "edit_app_langs", [app_id], body, content_type, "the app's languages")


def save_settings(authoring, app_id, *, attributes=None, properties=None, features=None):
    """The app settings page's saves, each made as ``proof/observe/hqside.py`` makes a person's: ``attributes``
    under ``hq`` through ``views/settings.py::edit_commcare_settings`` (which stores each through
    ``views/apps.py::edit_app_attr`` with ``all``), then ``properties`` and ``features`` through
    ``views/settings.py::edit_commcare_profile``, each beside the custom properties the page holds."""
    from proof.observe import hqside

    for name, value, save in (
        ("attributes", attributes, hqside.app_attributes),
        ("properties", properties, hqside.profile_properties),
        ("features", features, hqside.profile_features),
    ):
        if value:
            with authoring.step(f"build:settings:{name}", json.dumps(value, sort_keys=True).encode()):
                save(authoring.state, app_id, value)


def save_ui_translations(authoring, app_id, translations):
    """Each language's texts saved on the UI translations page (``views/apps.py::edit_app_ui_translations``,
    through ``proof/observe/hqside.py::ui_translations``, beside the texts the app holds for it)."""
    from proof.observe import hqside

    with authoring.step("build:ui-translations", json.dumps(translations, sort_keys=True).encode()):
        hqside.ui_translations(authoring.state, app_id, translations)


def save_module_attributes(authoring, app_id, menu, pairs, what):
    """A menu's settings saved as its settings page saves them (``views/modules.py::edit_module_attr`` with
    ``all``, which stores each attribute the post names), in the app's first language."""
    from proof.hq import operations

    with authoring.step(f"build:menu:{menu}:{what}", json.dumps(list(pairs)).encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body(pairs)
        ops.post(
            authoring,
            "edit_module_attr",
            [app_id, module.unique_id, "all"],
            body,
            content_type,
            f"the {what} of menu {menu}",
        )


def save_form_attributes(authoring, app_id, menu, form, pairs, what):
    """A form's settings saved as its settings page saves them (``views/forms.py::edit_form_attr`` with ``all``:
    ``_edit_form_attr`` stores each attribute the post names), in the app's first language."""
    from proof.hq import operations

    with authoring.step(f"build:form:{menu}.{form}:{what}", json.dumps(list(pairs)).encode()):
        held = operations.held_app(authoring.state, app_id).get_module(menu).get_form(form)
        body, content_type = ops.form_body(pairs)
        ops.post(
            authoring,
            "edit_form_attr",
            [app_id, held.unique_id, "all"],
            body,
            content_type,
            f"the {what} of form {menu}.{form}",
        )


def delete_form(authoring, app_id, menu, form):
    """A form deleted as the menu's form list deletes one (``views/forms.py::delete_form``)."""
    from proof.hq import operations

    with authoring.step(f"build:delete-form:{menu}.{form}"):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        held = module.get_form(form)
        ops.post(
            authoring,
            "delete_form",
            [app_id, module.unique_id, held.unique_id],
            b"",
            ops.FORM_CONTENT_TYPE,
            f"the deletion of form {menu}.{form}",
            redirects=True,
        )


def save_search_fields(authoring, app_id, menu, fields):
    """A menu's Search saved as the Case List page saves it (``views/modules.py::edit_module_detail_screens``,
    whose ``_gather_and_update_search_properties`` builds the menu's ``CaseSearch`` from ``search_properties``):
    ``fields`` as the page posts each (``name``, ``label`` and ``hint`` in the app's first language, and no
    appearance), no default filter, no title and no description."""
    from proof.hq import operations

    search = {
        "properties": [
            {"name": name, "label": label, "hint": "", "appearance": "", "receiver_expression": ""}
            for name, label in fields
        ],
        "default_properties": [],
        "custom_sort_properties": [],
        "title_label": "",
        "description": "",
        "auto_launch": False,
        "default_search": False,
        "inline_search": False,
        "search_button_display_condition": "",
        "blacklisted_owner_ids_expression": "",
    }
    with authoring.step(f"build:search:{menu}", json.dumps(search, sort_keys=True).encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body([("type", json.dumps("case")), ("search_properties", json.dumps(search))])
        ops.post(
            authoring,
            "edit_module_detail_screens",
            [app_id, module.unique_id],
            body,
            content_type,
            f"the search of menu {menu}",
        )


def change_app_model(authoring, app_id, what, change):
    """A value no page of HQ's writes, set on the app with HQ's own model and saved (``change(app)``, then
    ``app.save()``), in the operation ``build:model:<what>``."""
    from proof.hq import operations

    with authoring.step(f"build:model:{what}"):
        app = operations.held_app(authoring.state, app_id)
        change(app)
        app.save()


def _upload_image(authoring, app_id, view, args, path, filename, pairs, what):
    """The lane's stand-in picture for ``path`` (``proof/matrix/media.py::stand_in``) posted as HQ's media
    uploader posts one (``hqmedia/views.py::BaseProcessFileUploadView``: the file as ``Filedata``)."""
    from django.core.files.uploadedfile import SimpleUploadedFile
    from django.test.client import BOUNDARY, MULTIPART_CONTENT, encode_multipart

    from proof.matrix import media

    with authoring.step(f"build:{what}:{path}", path.encode()):
        data = media.stand_in(path)
        body = encode_multipart(
            BOUNDARY, {**dict(pairs), "Filedata": SimpleUploadedFile(filename, data, content_type="image/png")}
        )
        ops.post(authoring, view, [app_id, *args], body, MULTIPART_CONTENT, f"the picture at {path}")


def upload_picture(authoring, app_id, path):
    """A picture uploaded at ``path`` as HQ's media picker uploads one
    (``hqmedia/views.py::ProcessImageFileUploadView``: ``path`` and the file), which maps it in the app."""
    _upload_image(
        authoring, app_id, "hqmedia_uploader_image", [], path, path.rsplit("/", 1)[-1], [("path", path)], "picture"
    )


def upload_logo(authoring, app_id, slot):
    """A logo uploaded to the Android slot ``slot`` as the settings page's logo uploader uploads one
    (``hqmedia/views.py::ProcessLogoFileUploadView``, which maps it at
    ``jr://file/commcare/logo/data/<slot>.png`` and names that path in ``logo_refs``). Returns the path."""
    path = f"jr://file/commcare/logo/data/{slot}.png"
    _upload_image(authoring, app_id, "hqmedia_uploader_logo", [slot], path, f"{slot}.png", [], f"logo:{slot}")
    return path


def new_form(authoring, app_id, menu, *, case_action="none"):
    """A form added to the menu at ``menu`` as the menu's add-form button posts it (``views/forms.py::new_form``,
    ``form_type`` ``form``): ``case_action`` ``open`` adds a "Register" form opening the menu's case, ``update`` a
    "Followup" form requiring one, and ``none`` a "Survey" form with no case action."""
    from proof.hq import operations

    pairs = [("form_type", "form"), ("case_action", case_action)]
    with authoring.step(f"build:new-form:{menu}", json.dumps(pairs).encode()):
        module = operations.held_app(authoring.state, app_id).get_module(menu)
        body, content_type = ops.form_body(pairs)
        ops.post(
            authoring,
            "new_form",
            [app_id, module.unique_id],
            body,
            content_type,
            f"a new form of menu {menu}",
            redirects=True,
        )


def save_case_management(authoring, app_id, menu, form, *, change=None, diff=None, what="case management"):
    """A form's Case Management tab saved as the tab saves it (``views/forms.py::edit_form_actions``): the form's
    actions in the tab's shape (``form_action_diff.py::make_multi`` of what HQ holds), with ``change(actions)``
    applied to that JSON where given (the sections the tab posts whole: the case's external id, a condition, a
    child case, a close, the worker's own record), the property and name mappings as ``case_mapping_diff``
    (``diff``, ``form_action_diff.py::merge_case_mappings``' shape, each mapping carrying its ``update_mode``) and
    the form's ``requires`` as it holds it."""
    import copy

    from corehq.apps.app_manager.form_action_diff import make_multi

    from proof.hq import operations

    with authoring.step(
        f"build:case-management:{menu}.{form}",
        json.dumps({"diff": diff, "what": what}, sort_keys=True).encode(),
    ):
        held = operations.held_app(authoring.state, app_id).get_module(menu).get_form(form)
        actions = copy.deepcopy(make_multi(held.actions.to_json()))
        if change is not None:
            change(actions)
        body, content_type = ops.form_body(
            [
                ("actions", json.dumps(actions)),
                ("case_mapping_diff", json.dumps(diff or {})),
                ("requires", held.requires),
            ]
        )
        ops.post(
            authoring,
            "edit_form_actions",
            [app_id, held.unique_id],
            body,
            content_type,
            f"the {what} of form {menu}.{form}",
        )
