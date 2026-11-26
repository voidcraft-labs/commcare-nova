"""Nova's device fixture of a table brought in from HQ is, element for element, the one HQ's restore serves.

Contract: the local archive of ``hq-lookup-data`` (Nova's first reading of the base HQ made, emitted as the lane
emits every base) embeds its table in ``suite.xml`` as ``<fixture id="item-list:crops">``, and that fixture is the
one HQ's ``ItemListsProvider`` serves a worker for the table as the base's ``tables.json`` holds it
(``proof/observe/casedata.py::served_fixtures``, HQ's ``_get_global_items`` written as HQ caches it), the
``user_id`` attribute HQ gives each worker aside: the same row elements in the same order, each with the same
attributes (the table's row attributes), the same field elements in the same order, each with the same text and
attributes (a field's properties). That puts each of the three states of the table's ``note`` field where HQ's
restore puts it: no element for the row that holds no value of it, one empty element for the row that does not
hold it and for the row that holds it empty, which Core reads differently (``count(note)``) even where a
comparison reads them alike.

The plausible failures: a field of no value written as one empty element, or a field the row does not hold
dropped, which changes what ``count`` and a path test read; a field's second value dropped or the values
reordered; a property or a row attribute lost. Proof 3 compares the sessions Core runs on each, which a choice
list that reads a field's equality cannot tell apart.
"""

from __future__ import annotations

import json
import zipfile
from io import BytesIO

from lxml import etree

from proof.hq.check import hq_check
from proof.hq.operations import save_authored_tables
from proof.matrix.registry import HQ_APPS

DOCUMENT = "hq-lookup-data"


def _shape(element):
    """An element as a reader of a fixture reads it: its tag, its attributes, its text, and its children in order;
    ``user_id`` aside, which HQ writes per worker."""
    attributes = {key: value for key, value in element.attrib.items() if key != "user_id"}
    return (element.tag, sorted(attributes.items()), element.text or "", [_shape(child) for child in element])


def _archive_fixtures(archive) -> dict[str, tuple]:
    """Each fixture the archive's suite embeds, by its id."""
    with zipfile.ZipFile(BytesIO(archive)) as opened:
        suite = etree.fromstring(opened.read("suite.xml"))
    return {fixture.get("id"): _shape(fixture) for fixture in suite.iter("fixture")}


def test_novas_fixture_of_a_table_brought_in_is_the_one_hqs_restore_serves(hq, core_runner, documents):
    document = documents[DOCUMENT]
    configuration = document.exports["minimum"].configuration.hq()
    tables = json.loads((HQ_APPS / DOCUMENT / "tables.json").read_text(encoding="utf-8"))
    archived = _archive_fixtures(document.local_ccz_for("minimum").read_bytes())
    from proof.observe.casedata import served_fixtures

    with hq_check(configuration) as (state, _):
        save_authored_tables(state, tables)
        served = {}
        for written in served_fixtures(state):
            fixture = etree.fromstring(written)
            served[fixture.get("id")] = _shape(fixture)
    assert sorted(archived) == sorted(served) == ["item-list:crops"]
    assert archived == served

    # The three states of ``note`` stand where HQ's restore puts them: the row of no value has no element.
    rows = {
        dict(row[1])["code"]: [child[0] for child in row[3]] for row in served["item-list:crops"][3][0][3]
    }
    assert rows["c-beans"] == ["id", "name", "name"]
    assert rows["c-sorghum"] == rows["c-millet"] == ["id", "name", "name", "note"]
