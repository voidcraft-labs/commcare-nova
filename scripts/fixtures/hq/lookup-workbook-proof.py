"""Decode current Nova XLSX bytes with native HQ fixture upload code, without persistence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--hq-root", required=True, type=Path)
parser.add_argument("--exports", required=True, type=Path)
parser.add_argument("--python-path", type=Path)
args = parser.parse_args()
hq_root = args.hq_root.resolve()
sys.path.insert(0, str(hq_root))
if args.python_path:
    sys.path.append(str(args.python_path.resolve()))
def deny_network(*_args, **_kwargs):
    raise RuntimeError("Network disabled for native HQ evidence")
socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
os.environ["CCHQ_TESTING"] = "1"
os.environ["DJANGO_SETTINGS_MODULE"] = "testsettings"
from manage import init_hq_python_path
init_hq_python_path()
import django
django.setup()
from corehq.apps.fixtures.upload.workbook import get_workbook
from lxml import etree
expected = json.loads((args.exports / "expected.json").read_bytes())
book = get_workbook(str(args.exports / "lookup.xlsx"))
actual = []
for table in book.iter_tables("nova-lookup-proof"):
    columns = [field.name for field in table.fields]
    assert table.is_global is True
    rows = list(book.iter_rows(table, {}))
    assert [row.sort_key for row in rows] == list(range(len(rows)))
    assert all(book.get_key(row) is None and book.ownership[row] == {} for row in rows)
    values = [[row.fields[column][0].value for column in columns] for row in rows]
    actual.append({"tag": table.tag, "columns": columns, "rows": values})
    fixture = etree.fromstring((args.exports / f"{table.tag}.xml").read_bytes())
    assert fixture.attrib == {"id": f"item-list:{table.tag}"}
    assert len(fixture) == 1 and fixture[0].tag == f"{table.tag}_list"
    assert [[cell.text or "" for cell in row] for row in fixture[0]] == values
    assert all([cell.tag for cell in row] == columns for row in fixture[0])
assert actual == expected["tables"], (actual, expected["tables"])
assert sum(sheet.worksheet.max_row for sheet in book.workbook.worksheets) == expected["totalWorkbookRows"]
wide = get_workbook(str(args.exports / "columns.xlsx"))
wide_table, = wide.iter_tables("nova-lookup-proof")
assert [field.name for field in wide_table.fields] == [f"c{i}" for i in range(50)]
wide_row, = wide.iter_rows(wide_table, {})
assert [wide_row.fields[f"c{i}"][0].value for i in range(50)] == [f"v{i}" for i in range(50)]
# Demonstrates the upstream coercion responsible for the HQ-only export guard.
padding = get_workbook(str(args.exports / "padding.xlsx"))
padding_table, = padding.iter_tables("nova-lookup-proof")
padding_values = [row.fields["value"][0].value for row in padding.iter_rows(padding_table, {})]
assert padding_values == [value.strip() for value in expected["padding"]], padding_values
assert expected["stripCharacters"] == [point for point in range(0x110000) if chr(point).strip() == ""]
assert padding_values != expected["padding"]
# HQ imports the actual expanded app and regenerates case/meta binds on its
# own path; the suite proof consumes Nova's native downloadable-app carrier.
from unittest.mock import patch
from django.conf import settings
from django.test import override_settings
from corehq.apps.app_manager.models import Application
from corehq.apps.app_manager.xform import XForm
from corehq.apps.builds.models import BuildSpec
override_settings(CACHES={name: {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": f"nova-lookup-{name}"} for name in settings.CACHES}).enable()
for name in ["lookup-app", "lookup-reversed"]:
    with patch("corehq.apps.app_manager.models.applications.get_default_build_spec", return_value=BuildSpec(version="2.53.0", build_number=1)):
        app = Application.from_source(json.loads((args.exports / f"{name}.json").read_bytes()), "nova-lookup-proof")
    form = app.get_module(0).get_form(0)
    with patch("corehq.apps.app_manager.models.applications.domain_has_usercase_access", return_value=False), patch("corehq.apps.app_manager.xform.DONT_INDEX_SAME_CASETYPE.enabled", return_value=False), patch("corehq.apps.app_manager.xform.SAVE_ONLY_EDITED_FORM_FIELDS.enabled", return_value=False):
        compiled = XForm(form.source, domain="nova-lookup-proof")
        compiled.add_case_and_meta(form)
        compiled.strip_vellum_ns_attributes()
    (args.exports / f"{name}.hq.xml").write_bytes(etree.tostring(compiled.xml))
paths = ["corehq/apps/fixtures/upload/workbook.py", "corehq/util/workbook_json/excel.py", "corehq/apps/fixtures/models.py"]
print(json.dumps({"hqCommit": subprocess.check_output(["git", "-C", str(hq_root), "rev-parse", "HEAD"], text=True).strip(), "hqSourceHashes": {path: hashlib.sha256((hq_root / path).read_bytes()).hexdigest() for path in paths}, "novaSourceHashes": expected["sourceHashes"], "artifactHashes": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in args.exports.iterdir() if path.is_file()}, "tables": actual, "paddingInput": expected["padding"], "paddingDecoded": padding_values, "limits": "Actual native HQ workbook parser, table definitions, row models and lexical cells; independent lxml fixture decoding. No database persistence, replacement transaction, restore distribution or device runtime."}, indent=2))
