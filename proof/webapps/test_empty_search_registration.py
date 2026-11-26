"""Where Web Apps lands a worker who registers from a search that found nothing (``no-matches-basic``).

The journey: Patients searches first and inline, with one prompt ``patient_name``; a search that finds nothing
offers the list's one action, "Register patient", whose form names the new case; that list returns to the case
list after the form (``post_form_workflow`` ``case_list``). HQ's build of that return is a stack frame of the menu
and its search, the search's query keyed to the created case (``workflow.py::CaseListFormWorkflow``,
``WorkflowQueryMeta.to_stack_datum``), which Formplayer rebuilds by asking HQ's case fixture for it
(``MenuSessionFactory.rebuildSessionFromFrame``). HQ answers with the created case, and Formplayer still answers the
submission with the case list and no row: ``proof/formplayer/test_search.py`` holds that, and holds the same landing
for the journey made on HQ's own pages (``hq-empty-search``).

Contract: after Submit, the client stands on Patients' case list, which lists no row and still offers "Register
patient", and HQ's receiver holds the case under the name the worker gave. Plausible failures: a landing on the
form, on the home screen or on a list showing the created case, each of which would make Preview's Web Apps landing
(``lib/preview``) a claim about something the worker never sees.
"""

from __future__ import annotations

from lxml import etree

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "no-matches-basic"
SEARCHED = "Empty search patient"
GIVEN = "Name on the case"
# The form's one question, "Name", by the index the client writes for it.
NAME = "0"


def test_web_apps_lands_on_the_empty_list_after_registering_from_an_empty_search(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run(
                [
                    *steps.open_app(release.doc["name"]),
                    *steps.choose("Patients"),
                    *steps.type_prompt(0, SEARCHED),
                    *steps.run_search(),
                    steps.SCREEN,
                    *steps.click(steps.LIST_ACTION, "Register patient"),
                    *steps.answer(NAME, GIVEN),
                    steps.SCREEN,
                    *steps.submit_and_land(),
                    steps.SCREEN,
                ]
            )
            received = list(session.hq.submissions)
    searched, form, landed = run.screens
    evidence("empty-search-registration", {"searched": searched, "form": form, "landed": landed})
    assert run.page_errors == []
    assert form.get("form", {}).get("title") == "Register patient", form
    case_ns = "{http://commcarehq.org/case/transaction/v2}"
    (receipt,) = received
    (created,) = etree.fromstring(receipt.instance).findall(f"{case_ns}case")
    assert created.findtext(f"{case_ns}create/{case_ns}case_name") == GIVEN
    assert landed.get("form") is None, landed
    assert landed.get("list") is not None, landed
    assert landed["list"].get("rows") == [], landed
