"""Formplayer and lookup tables whose tags hold the words Core reads as its own data (defect 5).

Core picks a form instance's data by the words its reference contains
(commcare-core ``core/process/CommCareInstanceInitializer.java::generateRoot``
tests ``ledgerdb``, then ``casedb``, then ``fixture``), and the test is
case-sensitive. ``targeted-lookup-reserved-tags`` holds two selects, one over
a table whose tag splits ``casedb`` and holds 32 characters
(``clinic_case_db_codes_0123456789a``) and one over a table whose tag splits
``ledgerdb`` (``stock_ledger_db_codes``), each table two rows.

Contract, over HQ's build and HQ's restore of the document, served to
Formplayer by HQ's own views (``proof.formplayer.hq``): the form opens and
each select lists its table's two rows. The same holds with the tables
renamed to tags that hold the words in another case (``clinic_CaseDB_codes``,
``stock_LedgerDB_codes``), written in a fork: the tables through HQ's own
models, the form's source through HQ's app and its save, as a spelling
rule's test writes a form. And over the control's retained bytes, which keep
the tags from before step 2 refused them (``clinic_casedb_codes``,
``stock_ledgerdb_codes``), Formplayer does not open the form: it answers
Core's refusal to read the lookup table. The plausible failures: a select
that lists nothing over a split tag (so the rename would not fix the app), a
case-insensitive test (so the other-case tags would break and the rule would
refuse too little), and a control that opens (so the walk stop it holds
would be no witness of the defect).
"""

from __future__ import annotations

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind

DOCUMENT = "targeted-lookup-reserved-tags"
SELECTS = ("/data/clinic", "/data/item")
# The document's tags, and the tags the fork writes in their place.
TAGS = {
    "clinic_case_db_codes_0123456789a": "clinic_CaseDB_codes",
    "stock_ledger_db_codes": "stock_LedgerDB_codes",
}
REFUSAL = "Make sure the"


def _questions(tree):
    for node in tree or ():
        if isinstance(node, dict):
            yield node
            yield from _questions(node.get("children"))


def _opened(web):
    """The first form a worker reaches from the home screen, or the screen that stopped the way to it."""
    selections = []
    screen = web.navigate(selections)
    while screen_kind(screen) != "form":
        if screen_kind(screen) != "commands":
            return screen
        selections.append("0")
        screen = web.navigate(selections)
    return screen


def _choices(form):
    """Each select's choices, by its binding."""
    return {
        node["binding"]: node.get("choices") or []
        for node in _questions(form.get("tree"))
        if node.get("binding") in SELECTS
    }


def _renamed(published):
    """A ``change`` that renames each table to its other-case tag through HQ's models, and writes the form's
    source with the new tags through HQ's app and its save."""
    from corehq.apps.fixtures.models import LookupTable

    write = apps.form_written(published, {"0.0": lambda source: _with_tags(source)})

    def change(stored):
        for table in LookupTable.objects.filter(domain=published.unit.domain):
            table.tag = TAGS[table.tag]
            table.save()
        write(stored)

    return change


def _with_tags(source):
    for tag, renamed in TAGS.items():
        source = source.replace(tag, renamed)
    return source


def test_formplayer_lists_each_tables_rows_over_split_tags_and_other_case_tags(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    document = formplayer_documents[DOCUMENT]
    found = {}
    with apps.published(document, core_runner) as published:
        with apps.served(published, formplayer_runner) as served, served.run("split"):
            found["split"] = _opened(apps.web(formplayer_runner, served))
        with apps.served(published, formplayer_runner, change=_renamed(published)) as served, served.run("case"):
            found["other-case"] = _opened(apps.web(formplayer_runner, served))
    evidence("lookup-tags", {name: _choices(screen) or screen for name, screen in found.items()})
    for name, screen in found.items():
        assert screen_kind(screen) == "form", (name, screen)
        choices = _choices(screen)
        assert sorted(choices) == sorted(SELECTS), (name, choices)
        assert all(len(listed) == 2 for listed in choices.values()), (name, choices)


def test_formplayer_does_not_open_the_form_over_the_controls_tags(
    hq, core_runner, formplayer_runner, formplayer_controls, evidence
):
    control = formplayer_controls[DOCUMENT]
    with apps.published(control, core_runner) as published:
        with apps.served(published, formplayer_runner) as served, served.run("control"):
            screen = _opened(apps.web(formplayer_runner, served))
    evidence("control", screen)
    assert screen_kind(screen) != "form", screen
    assert REFUSAL in str(screen) and "lookup table" in str(screen), screen
