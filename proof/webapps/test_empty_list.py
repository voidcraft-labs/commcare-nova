"""The empty-list message a worker reads in Web Apps, in an app without English, before and after HQ's save.

Finding 41: Nova writes no empty-list text, so HQ's model default holds
English alone. Under ``USH_EMPTY_CASE_LIST_TEXT`` HQ's module settings page,
saved without a change, stores an empty text for the page's language, and in
an app with no English that blank is what HQ's app strings carry for the
list. ``targeted-empty-list-no-english`` is written in Spanish alone.

Contract, on the client run against Formplayer, for a list a search has
left empty:

- Nova's export: HQ's default reaches the worker, "List is empty.";
- after the module settings save: Formplayer hands the client a
  non-breaking space, and the client shows a message box holding only that,
  so the worker reads nothing.

Plausible failures: a save that stored no blank (the stored texts are
checked on both sides), a client that falls back to its own text for a
blank one (the worker would read the same message both times, and the
finding would be no harm in Web Apps), or a list that was never empty (the
row is there before the search and gone after it).
"""

from __future__ import annotations

from proof.editors import pages
from proof.observe import casedata
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "targeted-empty-list-no-english"
# The configuration that holds USH_EMPTY_CASE_LIST_TEXT, under which the page offers and saves the text.
CONFIGURATION = "maximum"
NBSP = "\u00a0"
PATH = [
    *steps.open_app("Clientes"),
    *steps.choose("Clientes"),
    steps.SCREEN,
    *steps.search_list("nobody by this name"),
    steps.SCREEN,
]


def test_the_module_settings_save_blanks_the_empty_list_message_a_worker_reads_without_english(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents[DOCUMENT]
    # The worker's cases are the ones the document's own restore fixes, made by HQ's receiver.
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document, CONFIGURATION) as project:
        assert "USH_EMPTY_CASE_LIST_TEXT" in project.toggles
        observed = {}
        for name, saves in (("nova", ()), ("saved", ((pages.MODULE_SETTINGS, project.module_id(0)),))):
            with project.released(
                formplayer_runner, saves=saves, driver=editor_driver, label=name, database=database
            ) as release:
                run = Session(release, editor_driver).run(PATH)
                listed, emptied = (screen["list"] for screen in run.screens)
                observed[name] = {
                    "langs": release.doc["langs"],
                    "stored": release.doc["modules"][0]["case_details"]["short"].get("no_items_text"),
                    "formplayer": run.answered("navigate_menu")[-1].json().get("noItemsText"),
                    "rowsBefore": [row["id"] for row in listed["rows"]],
                    "rowsAfter": [row["id"] for row in emptied["rows"]],
                    "message": emptied["empty"],
                    "pageErrors": run.page_errors,
                }
        evidence("empty-list", observed)
        nova, saved = observed["nova"], observed["saved"]
        for side in (nova, saved):
            assert side["langs"] == ["es"] and side["pageErrors"] == []
            assert side["rowsBefore"] == ["row-targeted-amina"] and side["rowsAfter"] == []
        assert nova["stored"] == {"en": "List is empty."}
        assert saved["stored"] == {"en": "List is empty.", "es": ""}
        assert nova["formplayer"] == "List is empty." and saved["formplayer"] == NBSP
        # The message box is laid out both times; after the save it holds a non-breaking space and nothing else.
        assert nova["message"] == {"html": "List is empty.", "text": "List is empty.", "visible": True}
        assert saved["message"] == {"html": "&nbsp;", "text": NBSP, "visible": True}
