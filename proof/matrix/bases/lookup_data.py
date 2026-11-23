"""``hq-lookup-data``: an app made in HQ whose form reads a lookup table holding every row shape a project space's
data can take beyond one plain value a field.

1. A new app (``views/apps.py::default_new_app``), named "Crop register" on the app page (``edit_app_attr``), with
   Web Apps turned on, so it is read as running on both platforms.
2. One global lookup table ``crops`` made with HQ's own models (``fixtures/models.py::LookupTable``,
   ``LookupTableRow``), as HQ's lookup table API saves one (``fixtures/resources/v0_1.py``:
   ``LookupTableResource.obj_create`` makes the ``TypeField`` list and ``item_attributes`` it is sent, and
   ``LookupTableItemResource.obj_create`` a row's ``fields`` through ``FieldsDictField.hydrate``, one ``Field`` a
   value, and its ``item_attributes`` as sent, at the next ``sort_key``). HQ's table page edits neither a field's
   properties nor a row's values, so the API is where a person makes them. The table has:

   - the row attribute ``code`` (``item_attributes``), each row's its own;
   - the field ``id``, one plain value a row;
   - the field ``name`` with the property ``lang`` (``TypeField.properties``), each row holding two values, an
     English one and a Hindi one, each with its ``lang``;
   - the field ``note``, which one row holds a value of, one row holds no value of (an empty ``field_list``),
     one row does not hold at all (no ``note`` key in ``fields``), and one row holds as the empty string.

   HQ's restore writes a row's attribute on the row's element, each value of a field as an element of the
   field's name with its properties as attributes, nothing for a field of no values, and one empty element for a
   field the row does not hold (``fixturegenerators.py::ItemListsProvider.to_xml``), so the four ``note`` states are
   three a device tells apart: one element with text, no element, and an empty element. Two rows have the same
   ``id`` and the same names under different codes, a duplicate-looking pair a choice keeps apart by its code.
   Every row holds a value of ``name`` with two values, so HQ's fixture list serves each row's fields in the
   detailed form (``FixtureResource.dehydrate_fields``: ``fields_without_attributes`` raises
   ``FixtureVersionError`` on the first field of more than one value).
3. A survey menu "Crop survey" (``views/modules.py::new_module``) whose one form's source is written by HQ's own
   form writer (``xform_builder.py::XFormBuilder``) and uploaded on the form page: a select ``crop`` whose choices
   are the table's rows, each saved as the row's ``code`` and labelled with its Hindi name; and a select
   ``bare_crop`` whose choices are the rows whose ``note`` is empty, saved as the row's ``code`` and labelled with
   its English name. The second list is where the three ``note`` states show to a worker: a row with an empty
   ``note`` element is offered, a row with no ``note`` element is not, and one with a note is not.

Its configuration is the lane's floor with ``LOOKUP_TABLES``, which a form that reads a table needs
(``helpers/validators.py::ApplicationValidator._validate_fixtures``), and ``CLOUDCARE`` for Web Apps.
"""

from __future__ import annotations

import json

from proof.hq.configuration import Configuration
from proof.matrix import ops
from proof.matrix.bases import _pages
from proof.matrix.bases.lookups import declare_instance, lookup_select
from proof.matrix.registry import Base

NAME = "Crop register"
MENU = "Crop survey"
TAG = "crops"

FIELDS = (("id", ()), ("name", ("lang",)), ("note", ()))
ATTRIBUTES = ("code",)
# Each row: its code, its id, its two names (English, Hindi), and its note: a string, [] for no value, or None for a
# row that does not hold the field.
ROWS = (
    ("c-maize", "maize", ("Maize", "Makka"), "Grows fast"),
    ("c-beans", "beans", ("Beans", "Sem"), []),
    ("c-sorghum", "sorghum", ("Sorghum", "Jowar"), None),
    ("c-millet", "millet", ("Millet", "Bajra"), ""),
    ("c-maize-hill", "maize", ("Maize", "Makka"), "Grows fast"),
)


def make_table(authoring):
    """The table ``crops``, in the operation ``build:tables``, as the module's docstring describes."""
    from corehq.apps.fixtures.models import Field, LookupTable, LookupTableRow, TypeField

    state = authoring.state
    with authoring.step("build:tables", json.dumps([FIELDS, ATTRIBUTES, ROWS]).encode()):
        made = LookupTable.objects.create(
            domain=state.domain,
            tag=TAG,
            is_global=True,
            fields=[TypeField(name=name, properties=list(properties), is_indexed=False) for name, properties in FIELDS],
            item_attributes=list(ATTRIBUTES),
        )
        for sort_key, (code, row_id, (english, hindi), note) in enumerate(ROWS):
            fields = {
                "id": [Field(value=row_id, properties={})],
                "name": [Field(value=english, properties={"lang": "en"}), Field(value=hindi, properties={"lang": "hin"})],
            }
            if note is not None:
                fields["note"] = [Field(value=value, properties={}) for value in ([note] if isinstance(note, str) else note)]
            LookupTableRow.objects.create(
                domain=state.domain,
                table=made,
                fields=fields,
                item_attributes={"code": code},
                sort_key=sort_key,
            )


def survey_source(name):
    """The survey form, as HQ's ``XFormBuilder`` writes it, with its two selects over ``crops``."""
    from corehq.apps.app_manager.xform_builder import XFormBuilder

    xform = XFormBuilder(name)
    lookup_select(xform, "crop", "Crop", TAG, label_field='name[@lang="hin"][1]', value_field="@code")
    lookup_select(
        xform,
        "bare_crop",
        "Crop with no note",
        TAG,
        label_field='name[@lang="en"][1]',
        value_field="@code",
        condition="note = ''",
    )
    declare_instance(xform, f"item-list:{TAG}", f"jr://fixture/item-list:{TAG}")
    return xform.tostring(xml_declaration=True).decode("utf-8")


def build(authoring) -> str:
    app_id = _pages.new_app(authoring)
    _pages.rename_app(authoring, app_id, NAME)
    _pages.turn_web_apps_on(authoring, app_id)
    make_table(authoring)
    _pages.new_survey_module(authoring, app_id, name=MENU)
    ops.upload_form_source(authoring, app_id, 0, 0, survey_source, "survey-source")
    return app_id


BASE = Base(
    id="hq-lookup-data",
    build=build,
    configuration=Configuration(privileges=frozenset({"CLOUDCARE", "LOOKUP_TABLES"})),
    exhibits=(
        "expressions-and-data/fields-properties-and-multi-valued-cells-name-lang-en-name-name",
        "expressions-and-data/item-attributes-and-per-row-attribute-values",
        "expressions-and-data/absent-field-vs-zero-values-vs-empty-string",
        "questions/itemset-refs-to-attr-or-property-qualified-fields",
    ),
)
