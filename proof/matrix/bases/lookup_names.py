"""A visit form selects rows from two HQ tables with names retained verbatim.

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

TABLES = (
    {
        "tag": "meeting.1",
        "fields": ("site.id", "label.1"),
        "rows": (("garden", "Garden"), ("library", "Library")),
    },
    {
        "tag": "ζωνες",
        "fields": ("clé", "région", "名前", "code.1", "zone.name"),
        "rows": (
            ("upland", "Upland", "upper", "on", "Upper zone"),
            ("lowland", "Lowland", "lower", "off", "Lower zone"),
        ),
    },
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
    lookup_select(form, "zone", "Zone", "ζωνες", value_field="clé", label_field="région")
    for table in TABLES:
        source = f"item-list:{table['tag']}"
        declare_instance(form, source, f"jr://fixture/{source}")
    return form.tostring(xml_declaration=True).decode("utf-8")


def build(authoring):
    from corehq.apps.fixtures.models import LookupTable

    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, "Site visits")
    _pages.turn_web_apps_on(authoring, app_id)
    make_tables(authoring, TABLES)
    for spec in TABLES:
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
    _pages.new_survey_module(authoring, app_id, name="Visit")
    ops.upload_form_source(authoring, app_id, 0, 0, visit_source, "visit-source")
    _pages.save_form_attributes(
        authoring,
        app_id,
        0,
        0,
        [
            ("form_filter", "instance('item-list:ζωνες')/ζωνες_list/ζωνες[clé = 'upland'][1]/code.1 = 'on'"),
        ],
        "visit offered in the upland zone",
    )
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
