"""Formplayer's end of form navigation over a link whose target its menu does not show, beside Core's session.

Contract: after a submission Formplayer runs the form's stack as Core does
and then walks the frame it is left through the screens it would show a
worker (``services/MenuSessionRunnerService.java::resolveFormGetNext``,
``MenuSessionFactory.java::rebuildSessionFromFrame``), so where the frame
names a command the menu holding it does not show, Formplayer stops at the
last screen that does show, where Core's own session, read as a host's loop
reads it (``CommCareSession.getNeededData``), goes on to the hidden target.
The two are observed on HQ's build of one Nova export
(``targeted-form-link-hidden-target``), from the same restore.

Plausible failures this catches: a harness whose Formplayer never ran the
form's stack (every next screen would be empty); one whose walk compares a
session to itself (the shown target is the accepted case: both open the same
form); and a Formplayer or Core pin at which the two start to agree, or to
differ on the shown target.
"""

from __future__ import annotations

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind

DOCUMENT = "targeted-form-link-hidden-target"


def _submitted(trace):
    """Formplayer's answer to each run's submission, by the title of the form submitted."""
    found = {}
    for run in trace["runs"]:
        form = next(step["response"] for step in run["steps"] if screen_kind(step.get("response")) == "form")
        found[form["title"]] = run["steps"][-1]["submit"]
    return found


def _core_next(trace):
    """What Core's session needs after each run's submission, by the title of the form submitted."""
    return {run["trace"][-1]["title"]: run["trace"][-1]["stackAfterSubmit"] for run in trace["runs"]}


def _xmlns(trace):
    return {run["trace"][-1]["title"]: run["trace"][-1]["xmlns"] for run in trace["runs"]}


def test_a_link_to_a_shown_form_opens_it_and_a_hidden_target_stops_formplayer_where_core_goes_on(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published:
        session = apps.installed(published)
        formplayer = apps.walked(formplayer_runner, session)
        core = apps.core_sessions(core_runner, published.build.files, session.restore, after_submit=True)
        submitted, needs, xmlns = _submitted(formplayer), _core_next(core), _xmlns(core)
        evidence(
            "side-by-side",
            {
                title: {
                    "core": needs[title],
                    "formplayer": {
                        "status": answer["status"],
                        "nextScreen": answer["nextScreen"]
                        and {
                            "kind": screen_kind(answer["nextScreen"]),
                            "title": answer["nextScreen"].get("title"),
                            "selections": answer["nextScreen"].get("selections"),
                            "commands": [c["displayText"] for c in answer["nextScreen"].get("commands") or []],
                        },
                    },
                }
                for title, answer in submitted.items()
            },
        )
        # Every form submitted, and HQ received each submission once.
        assert {title: answer["status"] for title, answer in submitted.items()} == {
            "To shown form": "success",
            "To hidden form": "success",
            "To hidden menu": "success",
            "Shown": "success",
        }
        assert len(session.hq.submissions) == 4

        # The accepted case: the link's target is shown, and both open it.
        shown = submitted["To shown form"]["nextScreen"]
        assert screen_kind(shown) == "form" and shown["title"] == "Shown" and shown["selections"] == ["1", "0"]
        assert needs["To shown form"]["next"] == {"needs": None, "command": "m1-f0", "form": xmlns["Shown"]}

        # A hidden form: Core's frame holds its command and Core needs nothing more, so its session opens the
        # form; Formplayer stops at the menu that holds it, which lists the shown form alone.
        hidden_form = submitted["To hidden form"]["nextScreen"]
        assert needs["To hidden form"]["steps"] == [
            {"id": "m1", "type": "COMMAND_ID", "value": None},
            {"id": "m1-f1", "type": "COMMAND_ID", "value": None},
        ]
        core_next = needs["To hidden form"]["next"]
        assert core_next["needs"] is None and core_next["command"] == "m1-f1"
        assert core_next["form"] is not None and core_next["form"] not in xmlns.values()
        assert screen_kind(hidden_form) == "commands"
        assert hidden_form["title"] == "Targets" and hidden_form["selections"] == ["1"]
        assert [command["displayText"] for command in hidden_form["commands"]] == ["Shown"]

        # A hidden menu: Core's frame holds its command and Core asks for a command inside it, so a host shows
        # the hidden menu's own forms; Formplayer stops at the app's first screen.
        hidden_menu = submitted["To hidden menu"]["nextScreen"]
        assert needs["To hidden menu"]["next"] == {"needs": "COMMAND_ID", "command": "m2", "form": None}
        assert screen_kind(hidden_menu) == "commands"
        assert hidden_menu["title"] == "Linked surveys" and hidden_menu["selections"] == []
        assert [command["displayText"] for command in hidden_menu["commands"]] == ["Start", "Targets"]

        # A form with no link leaves no frame, and both end there.
        assert submitted["Shown"]["nextScreen"] is None
        assert needs["Shown"]["nextFrameReady"] is False
