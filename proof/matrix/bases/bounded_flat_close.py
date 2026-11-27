"""HQ saves the 101 maximum and preserves the form-owned native close block.

Basic multi-select skips HQ's ordinary Case Management close action. This
base takes the exact unconditional Save to Case source that Formplayer
submitted in the 101-case reader witness, uploads it on HQ's form page, and
saves it in the current form editor.
"""

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base


DOCUMENT = "targeted-several-case-close"


def build(authoring):
    from proof.hq import operations
    from proof.observe import publish

    export = authoring.documents[DOCUMENT].exports["minimum"]
    with authoring.step("import the proven unconditional close"):
        published_id, refusal, lookups = publish.create(authoring.state, export)
        assert refusal is None and (lookups is None or lookups["errors"] == [])
        published = operations.held_app(authoring.state, published_id)
        exact_form = published.get_module(0).get_form(2)
        assert exact_form.default_name() == "Close all"
        source = exact_form.source

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Close selected records")
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_case_module(authoring, app_id, name="Records", case_type="sample")
    _pages.delete_form(authoring, app_id, 0, 0)
    ops.upload_form_source(authoring, app_id, 0, 0, lambda _name: source, "the proven flat close form")
    ops.set_json(authoring, app_id, "/modules/0/forms/0/requires", "case")
    ops.set_json(authoring, app_id, "/modules/0/forms/0/name", {"en": "Close all"})
    _pages.save_form_attributes(
        authoring, app_id, 0, 0, [("post_form_workflow", "default")], "return to app home"
    )
    pairs = [
        ("type", json.dumps("case")),
        ("short", json.dumps([_pages.column("name", "Name")])),
        ("sort_elements", "[]"),
        ("multi_select", "true"),
        ("auto_select", "true"),
        ("max_select_value", "101"),
    ]
    with authoring.step("save the 101-case selection"):
        module = operations.held_app(authoring.state, app_id).get_module(0)
        body, content_type = ops.form_body(pairs)
        ops.post(authoring, "edit_module_detail_screens", [app_id, module.unique_id], body, content_type,
                 "the bounded case list")
        saved = operations.held_app(authoring.state, app_id).get_module(0).case_details.short
        assert saved.multi_select and saved.auto_select and saved.max_select_value == 101
    return app_id


BASE = Base(
    id="hq-bounded-flat-close",
    build=build,
    configuration=Configuration(flags={"CASE_SEARCH_ADVANCED"}, privileges={"CLOUDCARE", "VELLUM_SAVE_TO_CASE"}),
    exhibits=("menus-and-case-lists/detail-max-select-value-for-flat-close",),
    vellum=((0, 0),),
)
