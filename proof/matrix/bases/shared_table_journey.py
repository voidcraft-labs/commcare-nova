"""The multilingual HQ app used by the shared lookup publishing journey."""

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages, lookups
from proof.matrix.registry import Base

TABLE = {
    "tag": "visit_sites",
    "fields": ("code", "name"),
    "rows": (("north", "Hill clinic"), ("south", "River clinic")),
}


def form_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    lookups.lookup_select(
        form, "site", {"en": "Clinic", "fra": "Clinique"}, TABLE["tag"], value_field="code"
    )
    lookups.declare_instance(form, "item-list:visit_sites", "jr://fixture/item-list:visit_sites")
    form.new_question("note", {"en": "Visit notes", "fra": "Notes de visite"}, "string")
    return form.tostring(xml_declaration=True).decode("utf-8")


def build(authoring):
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Clinic visits")
    _pages.turn_web_apps_on(authoring, app_id)
    _pages.set_languages(authoring, app_id, ("en", "fra"))
    lookups.make_tables(authoring, [TABLE])
    _pages.new_survey_module(authoring, app_id, name="Visits")
    ops.upload_form_source(authoring, app_id, 0, 0, form_source, "visit-source")
    return app_id


BASE = Base(
    id="hq-shared-table-journey",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "LOOKUP_TABLES"})),
    exhibits=(
        "application-and-settings/langs-order-langs-0-default",
        "questions/lookup-table-select-selectdynamic-mselectdynamic-itemset-nodeset",
    ),
    vellum=((0, 0),),
)
