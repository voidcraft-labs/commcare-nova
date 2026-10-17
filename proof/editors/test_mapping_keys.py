"""Which ID mapping values HQ's Case List page and HQ's build can hold.

An ID mapping is HQ's ``enum`` column: each entry's key is a stored value,
and HQ's build writes it unescaped into the column's display expression
(``detail_screen.py::Enum._xpath_template``). HQ's mapping dialog marks a key
holding ``&``, ``<``, ``>``, ``"`` or ``'`` as bad XML
(``hqwebapp/js/ui_elements/bootstrap3/ui-element-key-val-mapping.js::hasBadXML``)
and, while one is held, disables its OK button and labels it "Fix errors"
(``hqwebapp/partials/bootstrap3/key_value_mapping.html``). Nova refuses those
five characters in an ID mapping value
(``CASE_LIST_ID_MAPPING_KEY_CHARACTERS``) and its cutover removes such an
entry.

Contract, on ``targeted-label-sort`` as Nova's publish leaves it in HQ, its
first menu's ID mapping key ``10`` rewritten in a fork of the stored app for
each case, as a stored mapping would hold it:

- for ``&``, ``<``, ``>`` and ``"``, the Case List page's mapping dialog,
  opened with the column's own Edit button, shows OK disabled and reading
  "Fix errors", so a person in HQ can change nothing in the mapping until
  they remove the key;
- for ``'``, HQ builds the app and Core refuses to admit the build, so the
  app does not install from HQ;
- for ``a.b``, the dialog's OK is enabled and reads "OK", and Core admits
  the build and lists the case holding ``a.b`` under the entry's label.

Plausible failures: a dialog that opened another column's mapping or none
(``a.b``'s enabled OK rules out a dialog that is always refused), a fork that
rewrote no key, and a build Core refuses for another reason (``a.b``'s build
is admitted).
"""

from __future__ import annotations

import base64
import copy
import tempfile
from pathlib import Path

from lxml import etree

from proof.editors.conftest import corpus_document, write_evidence
from proof.rules.conftest import published

DOCUMENT = "targeted-label-sort"
# The first menu's ID mapping entry rewritten, and the case whose zone it maps.
KEY = "10"
LABEL = "South"
CASE = "targeted-kibera"
REFUSED_BY_THE_DIALOG = ("a&b", "a<b", "a>b", 'a"b')
REFUSED_BY_CORE = "a'b"
ACCEPTED = "a.b"
# The mapping column's own Edit button on the Case List tab (key_value_mapping_template's openModal), and the
# dialog it opens, which HQ appends to the page's body.
EDIT = "#case-detail-screen-config-tab button[data-bind*='openModal']"
DIALOG_OPEN = "document.querySelector('body > .hq-enum-modal') !== null"
DIALOG_OK = """() => {
    const buttons = [...document.querySelectorAll('body > .hq-enum-modal .modal-footer .btn-primary')];
    if (buttons.length !== 1) throw new Error(`The mapping dialog holds ${buttons.length} primary buttons.`);
    return { disabled: buttons[0].disabled, text: buttons[0].textContent.trim() };
}"""


def _rewrite_key(doc, key):
    """The app's JSON with the first menu's mapping entry ``KEY`` keyed ``key`` in every detail."""
    rewritten = 0
    for detail in doc["modules"][0]["case_details"].values():
        # A detail pair's values are its details and its own doc_type.
        if not isinstance(detail, dict):
            continue
        for column in detail.get("columns") or []:
            for entry in column.get("enum") or []:
                if column.get("format") == "enum" and entry.get("key") == KEY:
                    entry["key"] = key
                    rewritten += 1
    assert rewritten, f"the first menu holds no ID mapping entry {KEY!r}, so the fork rewrites nothing"
    return doc


def _store(app, key):
    """The stored app with the key rewritten, saved as HQ saves an app (inside a fork of the unit)."""
    from proof.hq import operations

    held = operations.held_app(app.unit, app.app_id)
    type(held).wrap(_rewrite_key(copy.deepcopy(held.to_json()), key)).save()


def _dialog(driver, app):
    """The Case List page of the first menu, its ID mapping's dialog opened: its OK button's state."""
    from django.urls import reverse

    from proof.editors import pages
    from proof.editors.hq import HQAnswers, editor_build
    from proof.hq import operations

    module = operations.held_app(app.unit, app.app_id).modules[0].unique_id
    path = reverse(pages.CASE_LIST.view, args=[app.unit.domain, app.app_id, module])
    editor_build()
    answers = HQAnswers(app.unit, app.unit)
    run = driver.run(
        [
            {"goto": path},
            {"until": "pages/ready", "arg": {"bar": pages.CASE_LIST.bar}},
            {"click": EDIT},
            {"waitFor": DIALOG_OPEN},
            {"eval": DIALOG_OK},
        ],
        answer=answers,
        deadline=120,
    )
    answers.check()
    assert run["pageErrors"] == [], run["pageErrors"]
    return run["outcomes"][-1]["value"]


def _restore_with_zone(document, value):
    """The document's restore with ``CASE``'s zone holding ``value``."""
    root = etree.fromstring((document.root / "restore.xml").read_bytes())
    namespace = {"c": "http://commcarehq.org/case/transaction/v2"}
    (zone,) = root.xpath(f"//c:case[@case_id='{CASE}']/c:update/c:zone", namespaces=namespace)
    zone.text = value
    return etree.tostring(root, xml_declaration=True, encoding="utf-8")


def _listed(core_runner, built, restored):
    """Core's admission of HQ's build and, where admitted, the first menu's list: ``(admitted, rows)``."""
    from proof.checks import proof3
    from proof.observe.sessions import admitted

    with tempfile.TemporaryDirectory(prefix="proof-mapping-keys-") as directory:
        arranged = proof3.arrange_build(built.files, Path(directory) / "build")
        with admitted(core_runner, arranged) as report:
            if not report.get("admitted") or report.get("app") is None:
                return False, None
            result = core_runner.evaluate(
                app=report["app"],
                restoreBase64=base64.b64encode(restored).decode("ascii"),
                session={"command": "m0-f0"},
                caseList={},
            )
    return True, result["caseList"]["rows"]


def test_hqs_mapping_dialog_and_build_hold_exactly_the_keys_nova_allows(hq, core_runner, editor_driver):
    document = corpus_document(DOCUMENT)
    observed = {}
    with published(document, core_runner) as app:
        for key in (*REFUSED_BY_THE_DIALOG, ACCEPTED):
            with app.unit.fork():
                _store(app, key)
                observed[key] = {"dialog": _dialog(editor_driver, app)}
        for key in (REFUSED_BY_CORE, ACCEPTED):
            built = app.spell(doc=lambda doc, key=key: _rewrite_key(doc, key)).build
            assert built.files is not None and not built.raised, built.raised
            admitted, rows = _listed(core_runner, built, _restore_with_zone(document, key))
            observed.setdefault(key, {}).update({"admitted": admitted, "rows": rows})
    write_evidence("mapping-keys", observed)

    for key in REFUSED_BY_THE_DIALOG:
        assert observed[key]["dialog"] == {"disabled": True, "text": "Fix errors"}, key
    assert observed[REFUSED_BY_CORE]["admitted"] is False
    accepted = observed[ACCEPTED]
    assert accepted["dialog"] == {"disabled": False, "text": "OK"}
    assert accepted["admitted"] is True
    (row,) = [row for row in accepted["rows"] if row["caseId"] == CASE]
    assert row["fields"][1].strip() == LABEL, row
