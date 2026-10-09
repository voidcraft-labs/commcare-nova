"""Case-free reports survive HQ's SQL/blob save and feed its actual export writer.

The parser returns an unsaved form with answers cached in memory. That is
not retention. This proof saves two distinct submissions through HQ's real
processor, then reads new domain-scoped models whose answers come from the
stored XML. Real TableConfiguration and workbook writing consume those
reloaded documents, with no case created or reused between visits.

Plausible failures: treating the parser cache as an archive, never running
the attachment commit callback, overwriting the first visit, or exporting
only a synthetic document. HQ's whole export over the forms index, from a
schema HQ makes of an app's builds, is ``proof/views/test_exports.py``.
"""

from __future__ import annotations

import hashlib

import pytest

from proof.hq import database, operations
from proof.hq.boot import HarnessRefusal
from proof.hq.branch import OnCommitRefused
from proof.hq.configuration import Configuration
from proof.hq.state import open_unit

CONFIGURATION = Configuration()
XMLNS = "http://example.com/proof/standalone-report"


def _root():
    return hashlib.sha256(b"proof/hq/test_report_retention").digest()


def _submission(form_id, visit_date, condition, bins):
    from lxml import etree

    root = etree.Element(f"{{{XMLNS}}}data", nsmap={None: XMLNS}, name="Inspection")
    for name, value in (
        ("site", "Riverside Park"),
        ("visit_date", visit_date),
        ("condition", condition),
        ("overflowing_bins", str(bins)),
    ):
        etree.SubElement(root, f"{{{XMLNS}}}{name}").text = value
    meta = etree.SubElement(root, "{http://openrosa.org/jr/xforms}meta")
    for name, value in (
        ("instanceID", form_id),
        ("userID", "inspector-1"),
        ("timeStart", "2026-10-01T10:00:00Z"),
        ("timeEnd", "2026-10-01T10:00:01Z"),
    ):
        etree.SubElement(meta, f"{{http://openrosa.org/jr/xforms}}{name}").text = value
    return etree.tostring(root, encoding="utf-8", xml_declaration=True)


def _table():
    from corehq.apps.export.models.new import ExportColumn, PathNode, ScalarItem, TableConfiguration

    columns = (
        ("Report id", ("form", "meta", "instanceID")),
        ("Site", ("form", "site")),
        ("Visit date", ("form", "visit_date")),
        ("Condition", ("form", "condition")),
        ("Overflowing bins", ("form", "overflowing_bins")),
    )
    return TableConfiguration(
        label="Visits",
        selected=True,
        path=[],
        columns=[
            ExportColumn(
                label=label,
                selected=True,
                item=ScalarItem(path=[PathNode(name=name) for name in path]),
            )
            for label, path in columns
        ],
    )


def test_case_free_reports_are_reloaded_from_hq_storage_and_written_as_distinct_export_rows(hq, tmp_path):
    from corehq.apps.export.export import get_export_writer, write_export_instance
    from corehq.apps.export.models.new import FormExportInstance
    from corehq.form_processor.exceptions import XFormNotFound
    from corehq.form_processor.models import CommCareCase, XFormInstance
    from corehq.form_processor.parsers.form import _create_new_xform
    from openpyxl import load_workbook

    first_xml = _submission("report-first", "2026-10-01", "needs_attention", 2)
    second_xml = _submission("report-second", "2026-10-02", "good", 0)
    with (
        database.fresh_database(),
        open_unit(CONFIGURATION, root_key=_root(), validate=None, transactional=False) as state,
    ):
        with state.operation("parse-without-saving", first_xml):
            parsed = _create_new_xform(state.domain, first_xml, attachments={}).submitted_form
            assert parsed.form_data["condition"] == "needs_attention"
            assert not parsed.is_saved()
            with pytest.raises(XFormNotFound):
                XFormInstance.objects.get_form(parsed.form_id, domain=state.domain)
            del parsed

        with state.operation("save-first-report", first_xml):
            first_id = operations.save_standalone_report(state, first_xml)
        with state.operation("save-second-report", second_xml):
            second_id = operations.save_standalone_report(state, second_xml)

        with state.operation("refuse-case-effects-without-processing", b""):
            from lxml import etree

            root = etree.fromstring(_submission("report-with-case", "2026-10-01", "good", 0))
            case = etree.SubElement(
                root,
                "{http://commcarehq.org/case/transaction/v2}case",
                case_id="unexpected-case",
                date_modified="2026-10-01T10:00:01Z",
                user_id="inspector-1",
            )
            etree.SubElement(case, "{http://commcarehq.org/case/transaction/v2}close")
            with pytest.raises(HarnessRefusal, match="must not carry case blocks"):
                operations.save_standalone_report(state, etree.tostring(root))
            with pytest.raises(XFormNotFound):
                XFormInstance.objects.get_form("report-with-case", domain=state.domain)

        documents = []
        with state.operation("reload-reports", b""):
            for form_id, expected_xml in ((first_id, first_xml), (second_id, second_xml)):
                reloaded = XFormInstance.objects.get_form(form_id, domain=state.domain)
                assert reloaded.is_saved() and reloaded.is_normal
                assert not hasattr(reloaded, "_form_json")
                assert reloaded.get_xml() == expected_xml
                assert reloaded.form_data["meta"]["instanceID"] == form_id
                assert reloaded.user_id == "inspector-1"
                assert CommCareCase.objects.using(reloaded.db).filter(domain=state.domain).count() == 0
                documents.append(reloaded.to_json())
                with pytest.raises(XFormNotFound):
                    XFormInstance.objects.get_form(form_id, domain="another-project")

        expected_rows = [
            ["report-first", "Riverside Park", "2026-10-01", "needs_attention", "2"],
            ["report-second", "Riverside Park", "2026-10-02", "good", "0"],
        ]
        with state.operation("export-reloaded-reports", b""):
            table = _table()
            assert [
                row.data
                for index, document in enumerate(documents)
                for row in table.get_rows(document, index, transform_dates=False)
            ] == expected_rows
            export = FormExportInstance(
                domain=state.domain,
                xmlns=XMLNS,
                name="Inspection reports",
                tables=[table],
                transform_dates=False,
            )
            output = tmp_path / "inspection-reports.xlsx"
            writer = get_export_writer([export], str(output), allow_pagination=False)
            with writer.open([export]):
                write_export_instance(writer, export, documents, include_hyperlinks=False)
            workbook = load_workbook(output, read_only=True)
            try:
                assert list(workbook["Visits"].values) == [tuple(table.get_headers()), *map(tuple, expected_rows)]
            finally:
                workbook.close()


def test_a_rollback_unit_refuses_hqs_real_report_attachment_commit_callback(hq):
    from corehq.form_processor.exceptions import XFormNotFound
    from corehq.form_processor.models import XFormInstance

    xml = _submission("not-retained", "2026-10-01", "good", 0)
    with open_unit(CONFIGURATION, root_key=_root(), validate=None) as state:
        with state.operation("save-needs-commit", xml):
            with pytest.raises(OnCommitRefused, match="commit"):
                operations.save_standalone_report(state, xml)
            with pytest.raises(XFormNotFound):
                XFormInstance.objects.get_form("not-retained", domain=state.domain)


def test_nonrollback_mode_does_not_admit_commit_callbacks_into_the_reusable_worker_database(hq):
    """Removing the rollback guard alone would also admit work in the worker's reusable database."""
    from django.db import transaction

    from proof.hq.branch import Unit, blob_db
    from proof.hq.couch import ComputedViewCouch

    ran = []
    with blob_db() as blobs:
        unit = Unit(
            CONFIGURATION,
            _root(),
            couch=ComputedViewCouch(),
            blob_db=blobs,
            changes=[],
            database=database.worker_database().name,
            transactional=False,
            strict=True,
        )
        with unit.opened(), unit.operation("worker-callback-refused", b""):
            with pytest.raises(OnCommitRefused, match="reusable worker database"):
                transaction.on_commit(lambda: ran.append(True))
    assert ran == []
