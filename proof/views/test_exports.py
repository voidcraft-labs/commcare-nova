"""Defects 24 and 30: the columns HQ's form export gives Nova's forms, and what a worker's submission puts in them.

Contract: HQ's form export is made from the app's builds and fed by the forms
index (``export/models/new.py::FormExportDataSchema.generate_schema_from_builds``,
``FormExportInstance.generate_instance_from_schema``, ``export/export.py::
get_export_file``, which reads the forms HQ's form pillow indexed as its
receiver saved them). So the columns are what HQ's build of Nova's form
holds, not what the author wrote:

- **defect 30**: a repeat counted by a hidden value gains a second node,
  ``nova_count_<repeat>``, which holds the same count (``targeted-repeat-count-copy``):
  its own column, beside the hidden value's, holding the count;
- **defect 24**: an extension child case is written twice, an active Save to
  Case block and an inert basic subcase beside it with ``condition: never``
  (``case-extension-registration``): the inert subcase's
  ``form.subcase_<i>.case.*`` columns are there, and empty in every row of
  a submission that made the extension case; and HQ's Case Management save
  resets the inert subcase's relationship to child, so the export of the
  saved app reads its index under another path.

The plausible failures: an export made from a schema the harness wrote, or
fed rows the harness wrote, either of which proves nothing of HQ's; a
column present but never filled, which a count's value or an empty
subcase's emptiness tells apart; and a save that changes nothing of the
export, which the saved app's own export shows.

Each document is published as Nova publishes it and released as HQ's
Releases page releases one (and, for the second, again after HQ's own Case
Management page saved it); its worker walks every form with Formplayer,
served by HQ's own views, in one run whose submissions stay in HQ; and HQ's
own export is made of the release's forms.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager, nullcontext

DOCUMENTS = ("targeted-repeat-count-copy", "case-extension-registration")
# HQ's export writes this for a value the submission does not hold (``export/const.py::MISSING_VALUE``).
MISSING = "---"


def _export(unit, app_id, xmlns, tmp_path, label):
    """HQ's own export of the forms of ``xmlns``: the schema from the app's builds, the instance HQ's export page
    makes of it, and the workbook its writer writes from the forms index, as ``{table: [headers, *rows]}``, with
    every item path the schema holds (what HQ's export page offers as a column, selected or not)."""
    from corehq.apps.export.export import get_export_file
    from corehq.apps.export.models.new import FormExportDataSchema, FormExportInstance
    from openpyxl import load_workbook

    with unit.operation(f"export:{label}", hashlib.sha256(label.encode()).digest()):
        schema = FormExportDataSchema.generate_schema_from_builds(unit.domain, app_id, xmlns)
        instance = FormExportInstance.generate_instance_from_schema(schema)
        instance.transform_dates = False
        exported = get_export_file([instance], [], str(tmp_path / f"{label}.xlsx"), include_hyperlinks=False)
    paths = sorted(
        {"/".join(node.name for node in item.path) for group in schema.group_schemas for item in group.items}
    )
    workbook = load_workbook(exported.path, read_only=True)
    try:
        return {sheet.title: [list(row) for row in sheet.values] for sheet in workbook.worksheets}, paths
    finally:
        workbook.close()


@contextmanager
def _walked(served, runner):
    """Every form of the release walked by Formplayer in one run of the served state, so each submission HQ's
    receiver took stays in HQ for the export to read."""
    from proof.formplayer.walk import Walk

    with served.run("export"):
        trace = Walk(runner, served.hq, domain=served.domain, app_id=served.build_id, scope=lambda name: nullcontext())
        walked = trace.run()
        yield walked


def _columns(table, needle):
    headers = table[0]
    return [index for index, header in enumerate(headers) if header is not None and needle in str(header)]


def test_a_repeat_counted_by_a_hidden_value_exports_a_second_column_holding_the_count(
    hq, core_runner, formplayer_runner, view_documents, tmp_path
):
    from proof.webapps import hq as webapps_hq

    document = view_documents[DOCUMENTS[0]]
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, label="count") as served:
            app = served.doc
            xmlns = app["modules"][0]["forms"][0]["xmlns"]
            with _walked(served, formplayer_runner) as walked:
                assert any(run["end"] == "submitted" for run in walked["runs"]), walked
                tables, _ = _export(served.unit, served.app_id, xmlns, tmp_path, "count")
    (main,) = [rows for title, rows in tables.items() if _columns(rows, "planned")]
    count = _columns(main, "nova_count_")
    planned = _columns(main, "planned")
    # A column the author's form does not hold, beside the hidden value's, holding the same count.
    assert count and planned, main[0]
    assert all(row[count[0]] == row[planned[0]] == "2" for row in main[1:]), main
    assert len(main) > 1, "HQ's export of the walked forms has no row"


def test_an_extension_case_exports_empty_inert_subcase_columns_whose_index_path_moves_after_hqs_save(
    hq, core_runner, formplayer_runner, editor_driver, view_documents, tmp_path
):
    from proof.editors import pages
    from proof.hq import operations
    from proof.webapps import hq as webapps_hq

    document = view_documents[DOCUMENTS[1]]
    found = {}
    with webapps_hq.project(document) as project:
        form_id = operations.held_app(project.unit, project.app_id).modules[0].forms[0].unique_id
        for name, saves in (("nova", ()), ("saved", ((pages.CASE_MANAGEMENT, form_id),))):
            with project.released(formplayer_runner, saves=saves, driver=editor_driver, label=name) as served:
                xmlns = served.doc["modules"][0]["forms"][0]["xmlns"]
                with _walked(served, formplayer_runner) as walked:
                    assert any(run["end"] == "submitted" for run in walked["runs"]), walked
                    found[name] = _export(served.unit, served.app_id, xmlns, tmp_path, name)
    (nova_tables, nova_paths), (_, saved_paths) = found["nova"], found["saved"]
    nova = next(rows for rows in nova_tables.values() if _columns(rows, "subcase_"))
    headers = [str(header) for header in nova[0]]
    # Each extension child case is an active Save to Case block (``nova_subcases/nova_subcase_<i>``) and an inert
    # basic subcase at the same position (``subcase_<i>``); a basic child case at a position no block holds is
    # neither.
    blocks = {header.split(".")[2].rsplit("_", 1)[1] for header in headers if ".__nova_subcase_" in header}
    inert = [
        index for index, header in enumerate(headers) if header.split(".")[1:2] in ([f"subcase_{i}"] for i in blocks)
    ]
    basic = [
        index
        for index, header in enumerate(headers)
        if header.startswith("form.subcase_") and header.split(".")[1].rsplit("_", 1)[1] not in blocks
    ]
    shown = {headers[index]: [row[index] for row in nova[1:]] for index in inert + basic}
    assert inert and basic and len(nova) > 1, json.dumps(shown)
    # The inert subcase's columns hold HQ's mark for a value the submission does not hold (``export/const.py``,
    # ``MISSING_VALUE``) in every row, where the basic child case beside them holds its case id.
    assert all(row[index] == MISSING for row in nova[1:] for index in inert), json.dumps(shown)
    assert all(row[index] not in (None, "", MISSING) for row in nova[1:] for index in basic), json.dumps(shown)
    # HQ's Case Management save resets the inert subcase's relationship to child, so its index columns move: the
    # saved app's export offers no ``@relationship`` column for it, and reads its index under another path.
    nova_index = [path for path in nova_paths if path.startswith("form/subcase_") and "/case/index/" in path]
    saved_index = [path for path in saved_paths if path.startswith("form/subcase_") and "/case/index/" in path]
    assert any(path.endswith("/@relationship") for path in nova_index), nova_index
    assert not any(path.endswith("/@relationship") for path in saved_index), saved_index
    assert nova_index != saved_index, (nova_index, saved_index)
