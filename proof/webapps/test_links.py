"""Where a worker lands in Web Apps after a form whose link names a hidden target, end to end.

``targeted-form-link-hidden-target``: three forms of one menu each link,
with no condition, to one target: a form shown in another menu, a form of
that menu the worker's menu does not offer, and a menu the worker is not
offered. Finding 58 observed Formplayer's answer to each submission
(``proof/formplayer/test_end_of_form.py``); this is the whole path a worker
takes: the form opened by clicks in the client, submitted with its own
Submit button, the submission sent to HQ, and the screen the client then
shows.

Contract, on the released build of Nova's export:

- the link to the shown form opens that form;
- the link to the hidden form leaves the worker on the menu that holds it,
  which lists its shown form alone;
- the link to the hidden menu leaves the worker on the app's first screen;
- each time HQ's receiver processes exactly one submission and the client
  shows the message HQ's receiver answered for it (the form's name, saved),
  so no path loses the form.

Plausible failures: a client that shows an error or stays on the submitted
form when Formplayer answers with a screen other than the link's target, a
hidden form opened all the same (what Core's own session does), or a
submission sent twice.
"""

from __future__ import annotations

import pytest

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "targeted-form-link-hidden-target"
START = steps.path(steps.open_app("Linked surveys"), steps.choose("Start"))

LINKS = {
    "shown form": ("To shown form", {"form": "Shown"}),
    "hidden form": ("To hidden form", {"title": "Targets", "commands": ["Shown"]}),
    "hidden menu": ("To hidden menu", {"title": "Linked surveys", "commands": ["Start", "Targets"]}),
}


@pytest.mark.parametrize("link", sorted(LINKS))
def test_web_apps_follows_a_link_to_a_shown_form_and_stops_before_a_hidden_target(
    link, hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    source, expected = LINKS[link]
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run([*START, *steps.choose(source), steps.SCREEN, *steps.submit_form(), steps.SCREEN])
            received = len(session.hq.submissions)
    opened, landed = run.screens
    submitted = run.answered("submit-all")
    evidence(f"link-{link.replace(' ', '-')}", {"opened": opened, "landed": landed, "submissions": received})
    assert run.page_errors == [] and run.dialogs == []
    # The source form opened, and its one submission reached HQ and was accepted.
    assert opened["form"]["title"] == source
    assert len(submitted) == 1 and submitted[0].json()["status"] == "success"
    assert received == 1
    # HQ's receiver's own message for the form it processed, which the client shows the worker.
    assert landed["alerts"] == [f"'{source}' successfully saved!"]
    if "form" in expected:
        assert landed["form"]["title"] == expected["form"]
        assert landed["breadcrumbs"][-1] == expected["form"]
    else:
        assert "form" not in landed
        assert landed["title"] == expected["title"]
        assert [command["text"] for command in landed["commands"]] == expected["commands"]
