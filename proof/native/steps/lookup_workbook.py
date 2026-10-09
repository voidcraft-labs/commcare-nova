"""HQ's reading of Nova's lookup workbooks, and its regeneration of the lookup forms (``lookup`` family).

HQ's workbook reader (``fixtures/upload/workbook.py::get_workbook`` with its
``iter_tables``, ``iter_rows``, ``get_key`` and ``ownership``) reads Nova's
three workbooks: the corpus (``lookup.xlsx``), a 50-column table
(``columns.xlsx``) and the padding counterexample (``padding.xlsx``). What it
read is returned for the test to compare with the producer's
``expected.json`` and the fixture XML Nova emits. HQ then regenerates the two
lookup forms (``lookup-app.hq.xml``, ``lookup-reversed.hq.xml``).
"""

from proof.native.hq_support import import_source, native_check, regenerate_form

DOMAIN = "nova-lookup-proof"


def _read(workbook):
    from corehq.apps.fixtures.upload.workbook import get_workbook

    book = get_workbook(str(workbook))
    tables = []
    for table in book.iter_tables(DOMAIN):
        columns = [field.name for field in table.fields]
        rows = list(book.iter_rows(table, {}))
        tables.append(
            {
                "tag": table.tag,
                "isGlobal": table.is_global,
                "columns": columns,
                "sortKeys": [row.sort_key for row in rows],
                "keys": [book.get_key(row) for row in rows],
                "ownership": [book.ownership[row] for row in rows],
                "values": [[row.fields[column][0].value for column in columns] for row in rows],
            }
        )
    return {"tables": tables, "totalRows": sum(sheet.worksheet.max_row for sheet in book.workbook.worksheets)}


def lookups(session):
    exports = session.family("lookup")
    with native_check(DOMAIN):
        corpus = _read(exports / "lookup.xlsx")
        wide = _read(exports / "columns.xlsx")
        padding = _read(exports / "padding.xlsx")
        for name in ["lookup-app", "lookup-reversed"]:
            app = import_source((exports / f"{name}.json").read_bytes(), DOMAIN)
            (exports / f"{name}.hq.xml").write_bytes(regenerate_form(app.get_module(0).get_form(0), DOMAIN))
    return {"corpus": corpus, "wide": wide, "padding": padding}
