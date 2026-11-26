"""A visit form selects rows from two HQ tables with names retained verbatim: one whose names hold a period, and
one whose shown and saved columns hold letters outside ASCII, which its variants' display conditions read.

The table editor saves the exact definitions. Vellum saves the itemsets and their
field references. Each selected row populates a different field, including when
the two rows occupy the same position in their respective fixtures. The unused
uncased column belongs to the data restored from HQ and needs no XPath token.
"""

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.lookups import declare_instance, lookup_select, make_tables
from proof.matrix.registry import Base

ZONES = {
    "tag": "zones",
    "fields": ("code", "clé", "région", "名前", "code.1", "zone.name"),
    "rows": (
        ("upland", "upland", "Upland", "upper", "on", "Upper zone"),
        ("lowland", "lowland", "Lowland", "lower", "off", "Lower zone"),
    ),
}
TABLES = (
    {
        "tag": "meeting.1",
        "fields": ("site.id", "label.1"),
        "rows": (("garden", "Garden"), ("library", "Library")),
    },
    # A select shows région and saves clé, names HQ's form builder keeps as written; its variants' display
    # conditions read code, code.1, zone.name and région. No form reads a table whose tag holds letters outside
    # ASCII: HQ's form builder drops such a table's declaration on save, and HQ then refuses the form.
    ZONES,
)


def visit_source(name):
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    form = XFormBuilder(name)
    lookup_select(
        form,
        "site",
        "Meeting site",
        "meeting.1",
        value_field="site.id",
        label_field="label.1",
    )
    lookup_select(form, "zone", "Zone", "zones", value_field="clé", label_field="région")
    for table in TABLES:
        source = f"item-list:{table['tag']}"
        declare_instance(form, source, f"jr://fixture/{source}")
    return form.tostring(xml_declaration=True).decode("utf-8")


def make_saved_tables(authoring, tables):
    """Each of ``tables`` made with HQ's own models (``lookups.make_tables``), then saved on HQ's table editor as a
    person saves its definition (``update_lookup_tables``), which keeps each name as written."""
    from corehq.apps.fixtures.models import LookupTable

    make_tables(authoring, tables)
    for spec in tables:
        table = LookupTable.objects.get(domain=authoring.state.domain, tag=spec["tag"])
        payload = {
            "tag": spec["tag"],
            "fields": {name: {} for name in spec["fields"]},
            "description": "",
            "is_global": True,
        }
        body, content_type = ops.json_body(payload)
        with authoring.step(f"build:table-save:{spec['tag']}", body):
            response = ops.post(
                authoring,
                "update_lookup_tables",
                [table.id.hex],
                body,
                content_type,
                "the lookup table definition",
                method="PUT",
            )
        saved = json.loads(response.content)
        if saved.get("tag") != spec["tag"] or [f["name"] for f in saved.get("fields", [])] != list(spec["fields"]):
            raise ValueError(f"HQ's table editor did not keep the definition of {spec['tag']!r}: {saved}")


def build(authoring):
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Site visits")
    _pages.turn_web_apps_on(authoring, app_id)
    make_saved_tables(authoring, TABLES)
    _pages.new_survey_module(authoring, app_id, name="Visit")
    ops.upload_form_source(authoring, app_id, 0, 0, visit_source, "visit-source")
    # No display condition reads a table here: HQ checks one with an XPath reader of unaccented names alone, so a
    # condition reading région fails HQ's own build (``hq-lookup-names/non-ascii-column-in-form-condition``).
    return app_id


BASE = Base(
    id="hq-lookup-names",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "LOOKUP_TABLES"})),
    exhibits=(
        "expressions-and-data/tag-or-field-name-holding-a-period",
        "expressions-and-data/tag-or-field-name-with-non-ascii-letters",
    ),
    vellum=((0, 0),),
)
