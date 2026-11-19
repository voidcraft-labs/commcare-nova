"""``hq-lookups``: an app made in HQ whose form reads lookup tables a project space holds.

1. A new app (``views/apps.py::default_new_app``), named "Farm visits" on the
   app page (``edit_app_attr``).
2. Four global lookup tables made with HQ's own models
   (``fixtures/models.py::LookupTable``, ``LookupTableRow``), as HQ's
   table page saves them: ``districts`` and ``villages``, whose rows name a
   district; ``crop-types``, a tag holding a hyphen; and ``seasons``.
3. A survey menu "Farm survey" (``views/modules.py::new_module``) whose one
   form's source is written by HQ's own form writer
   (``xform_builder.py::XFormBuilder``) and uploaded on the form page: a
   text question ``farmer_name``; a select ``district`` whose choices are
   the rows of ``districts``; a select ``village`` whose choices are the
   rows of ``villages`` whose ``district`` is the district answered; a
   select ``crop`` over ``crop-types``; and the table ``seasons`` declared
   as an instance the form reads nowhere. ``XFormBuilder`` has no type for a
   select over a table, so each such select is written in the shape HQ's
   form builder saves one (``Vellum/src/itemset.js``: a ``select1`` holding
   an ``itemset`` whose ``label`` and ``value`` name the table's fields, the
   table declared as ``item-list:<tag>`` from ``jr://fixture/item-list:<tag>``).
   The form is then saved in HQ's form builder (``vellum``), which keeps an
   instance no question reads (``Vellum/src/writer.js`` writes every parsed
   instance; ``form.js`` drops one only as the last question naming it goes).

Its configuration is the lane's floor with ``LOOKUP_TABLES``, which a form
that reads a table needs (``helpers/validators.py::ApplicationValidator._validate_fixtures``).
Web Apps is off, as ``Application.cloudcare_enabled`` defaults, and its
content runs on Android, so its preselected declaration is Android only.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.registry import Base

NAME = "Farm visits"
MENU = "Farm survey"

# Each table as HQ's table page saves one: global, its fields, then its rows, each a value per field.
TABLES = (
    {
        "tag": "districts",
        "fields": ("id", "name"),
        "rows": (("d1", "Upper valley"), ("d2", "Lower valley")),
    },
    {
        "tag": "villages",
        "fields": ("id", "name", "district"),
        "rows": (
            ("v1", "Kalama", "d1"),
            ("v2", "Mbeya", "d1"),
            ("v3", "Rusumo", "d2"),
        ),
    },
    {
        "tag": "crop-types",
        "fields": ("id", "name"),
        "rows": (("maize", "Maize"), ("beans", "Beans")),
    },
    {
        "tag": "seasons",
        "fields": ("id", "name"),
        "rows": (("long", "Long rains"), ("short", "Short rains")),
    },
)


def make_tables(authoring, tables):
    """Each of ``tables`` (``{tag, fields, rows}``) made global with HQ's own models, in the operation
    ``build:tables``, as HQ's table page saves one: ``LookupTable`` with a ``TypeField`` a field and no property,
    then one ``LookupTableRow`` a row in order, each field holding one ``Field`` with no property
    (``fixtures/models.py``)."""
    from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow, TypeField

    state = authoring.state
    with authoring.step("build:tables", json.dumps(tables, sort_keys=True).encode()):
        for table in tables:
            made = LookupTable.objects.create(
                domain=state.domain,
                tag=table["tag"],
                is_global=True,
                fields=[TypeField(name=name, properties=[], is_indexed=False) for name in table["fields"]],
                item_attributes=[],
            )
            for sort_key, row in enumerate(table["rows"]):
                LookupTableRow.objects.create(
                    domain=state.domain,
                    table=made,
                    fields={
                        name: [Field(value=value, properties={})]
                        for name, value in zip(table["fields"], row, strict=True)
                    },
                    item_attributes={},
                    sort_key=sort_key,
                )


def declare_instance(xform, instance_id, src):
    """The secondary instance ``instance_id`` from ``src`` declared in the form's model after its data instance,
    after every instance declared before it, as HQ's form builder writes one."""
    from lxml import etree

    model = xform._etree.xpath("./h:head/x:model", namespaces=xform.ns)[0]
    instances = model.findall(f"{{{xform.ns['x']}}}instance")
    instances[-1].addnext(etree.Element(f"{{{xform.ns['x']}}}instance", id=instance_id, src=src))


def lookup_select(xform, name, label, tag, *, label_field="name", value_field="id", condition=None):
    """A select ``name`` whose choices are the rows of the table ``tag``, written as HQ's form builder writes
    one: ``XFormBuilder``'s question (its data node, its ``xsd:string`` bind and its label's itext), its control a
    ``select1`` holding an ``itemset`` over ``instance('item-list:<tag>')/<tag>_list/<tag>`` (filtered by
    ``condition`` where given), whose ``label`` and ``value`` name the table's fields."""
    from lxml import etree

    xform.new_question(name, label, "string")
    # XFormBuilder makes its controls with lxml's ``E``, which names no namespace; the form's own default
    # namespace is theirs once the source is written out, so the control is found, and the itemset made, so too.
    control = xform._etree.xpath(f'./h:body/input[@ref="/data/{name}"]', namespaces=xform.ns)[0]
    control.tag = "select1"
    nodeset = f"instance('item-list:{tag}')/{tag}_list/{tag}"
    if condition is not None:
        nodeset = f"{nodeset}[{condition}]"
    itemset = etree.SubElement(control, "itemset", nodeset=nodeset)
    etree.SubElement(itemset, "label", ref=label_field)
    etree.SubElement(itemset, "value", ref=value_field)


def survey_source(name):
    """The survey form, as HQ's ``XFormBuilder`` writes it, with its selects over tables."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    xform.new_question("farmer_name", "Farmer's name", "string")
    lookup_select(xform, "district", "District", "districts")
    lookup_select(xform, "village", "Village", "villages", condition="district = /data/district")
    lookup_select(xform, "crop", "Main crop", "crop-types")
    # In the order of their ids, as HQ's form builder and Nova both write a form's instances.
    for tag in sorted(("districts", "villages", "crop-types", "seasons")):
        declare_instance(xform, f"item-list:{tag}", f"jr://fixture/item-list:{tag}")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    make_tables(authoring, [dict(table, fields=list(table["fields"])) for table in TABLES])
    _pages.new_survey_module(authoring, app_id, name=MENU)
    ops.upload_form_source(authoring, app_id, 0, 0, survey_source, "survey-source")
    return app_id


BASE = Base(
    id="hq-lookups",
    build=build,
    configuration=Configuration(privileges=frozenset({"LOOKUP_TABLES"})),
    exhibits=(
        "questions/text-input-xsd-string",
        "questions/lookup-table-select-selectdynamic-mselectdynamic-itemset-nodeset",
        "questions/itemset-label-value-refs-to-lookup-fields",
        "questions/itemset-filter-lifting-into-predicate",
        "expressions-and-data/table-tag-in-nova-s-grammar",
        # KEPT_AT_HQ's row for a table's and its rows' ids: a reading meets them where the app reads a table.
        "expressions-and-data/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table",
        "expressions-and-data/declared-unreferenced-fixture-instance-item-list-locations-user",
        "menus-and-case-lists/module-with-case-type-survey-module",
    ),
    vellum=((0, 0),),
)
