"""The pinned HQ editor saves 101 for a list that closes its selected cases."""

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base


def _source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("ready", None, None, calculate="'yes'")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring):
    from proof.hq import operations

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Close selected records")
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.new_case_module(authoring, app_id, name="Records", case_type="record")
    _pages.delete_form(authoring, app_id, 0, 0)
    ops.upload_form_source(authoring, app_id, 0, 0, _source, "case close with a constant Hidden Value")
    ops.set_json(authoring, app_id, "/modules/0/forms/0/requires", "case")
    ops.set_json(authoring, app_id, "/modules/0/forms/0/actions/close_case/condition/type", "always")
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
    configuration=Configuration(flags={"CASE_SEARCH_ADVANCED"}, privileges={"CLOUDCARE"}),
    exhibits=("menus-and-case-lists/detail-max-select-value-for-flat-close",),
)
