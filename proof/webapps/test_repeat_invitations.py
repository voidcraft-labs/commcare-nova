"""The signed web client draws each published repeat invitation and adds a real row through its own button."""

import pytest
from lxml import etree

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

INVITATIONS = {"eval": """() => [...document.querySelectorAll("#webforms button.add")]
  .filter(button => button.getClientRects().length).map(button => button.textContent.trim())"""}


@pytest.mark.parametrize(("language", "first", "later"), [
    ("en", "Record the first visit", "Record another visit"),
    ("es", "Registrar la primera visita", "Registrar otra visita"),
])
def test_the_released_app_draws_the_translated_add_button(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence, language, first, later,
):
    with webapps_hq.project(webapps_documents["targeted-repeat-invitations"]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            before = [*steps.open_app(release.doc["name"])]
            if language != "en":
                before.extend(steps.choose_language(language, [steps.SETTLE]))
            before.extend([*steps.choose("Visits"), *steps.choose("Record visits")])
            add = steps.add_repeat(0)
            run = session.run([*before, INVITATIONS, *add, INVITATIONS, *steps.submit_and_land()])
            received, = session.hq.submissions
    assert not run.page_errors, run.page_errors
    assert run.value(len(before)) == [first], run.outcomes
    assert run.value(len(before) + len(add) + 1) == [later], run.outcomes
    assert len(etree.fromstring(received.instance).findall("{*}visit")) == 1
    evidence("repeat-invitations-" + language, {"first": first, "later": later, "instance": received.instance.decode()})
