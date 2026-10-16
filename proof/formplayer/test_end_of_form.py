"""Formplayer's end of form navigation over a link whose target its menu does not show, beside Core's session.

Contract: after a submission Formplayer runs the form's stack as Core does
and then walks the frame it is left through the screens it would show a
worker (``services/MenuSessionRunnerService.java::resolveFormGetNext``,
``MenuSessionFactory.java::rebuildSessionFromFrame``), so where the frame
names a command the menu holding it does not show, Formplayer stops at the
last screen that does show, where Core's own session, read as a host's loop
reads it (``CommCareSession.getNeededData``), goes on to the hidden target.
The two are observed on HQ's release of one Nova export
(``targeted-form-link-hidden-target``), Formplayer's requests answered by
HQ's own views (``proof.formplayer.hq``) and Core's session run over HQ's
restore of the same cases.

Plausible failures this catches: a harness whose Formplayer never ran the
form's stack (every next screen would be empty); one whose walk compares a
session to itself (the shown target is the accepted case: both open the same
form); and a Formplayer or Core pin at which the two start to agree, or to
differ on the shown target.

Two more documents hold what Nova writes for where a form goes after submit,
each on HQ's release of Nova's export:

- ``targeted-multi-select-destinations``: one follow-up for each destination
  a menu offers, in menus that select several cases and under them. Contract:
  Formplayer lands ``module`` on the menu's case list, ``firstMenu`` on the
  app's first screen, ``parentMenu`` on the parent menu with its forms and
  child menus, and ``previous`` on the screen before the form. The plausible
  failures: a destination HQ builds as another (``root`` read as the app's
  home, ``parent_module`` as the form's own menu), and a frame that stops
  Formplayer short of the screen.
- ``targeted-hidden-from-menu``: a menu and forms off the menu. Contract: the
  menus list neither hidden form nor the hidden menu; a link to a hidden form
  lands on the menu that holds it, and a link into the hidden menu on the
  app's first screen; an entry point that ignores display conditions opens
  its hidden form, and one that does not lands where a link would
  (``MenuSessionRunnerService.advanceSessionWithEndpoint`` reads
  ``respect-relevancy``). The plausible failures: a hidden item listed, and an
  entry point whose ``respect-relevancy`` Formplayer no longer reads, so the
  builder's copy and the docs would say what Web Apps does not do.
"""

from __future__ import annotations

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind

DOCUMENT = "targeted-form-link-hidden-target"
DESTINATIONS = "targeted-multi-select-destinations"
HIDDEN = "targeted-hidden-from-menu"


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
        with apps.served(published, formplayer_runner) as served:
            formplayer = apps.walked(formplayer_runner, served)
            received = list(served.hq.submissions)
            restore = served.hq.restores[0]
        core = apps.core_sessions(core_runner, published.build.files, restore, after_submit=True)
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
        assert len(received) == 4

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


def _landing(screen):
    """A screen Formplayer answers with, as these tests compare it."""
    if screen is None:
        return None
    return {
        "kind": screen_kind(screen),
        "title": screen.get("title"),
        "commands": [command["displayText"] for command in screen.get("commands") or []],
    }


def test_each_after_submit_destination_lands_where_the_model_says(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[DESTINATIONS], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            submitted = _submitted(apps.walked(formplayer_runner, served))
    landed = {title: _landing(answer["nextScreen"]) for title, answer in submitted.items()}
    evidence("landed", {title: {"status": submitted[title]["status"], "landed": landed[title]} for title in landed})

    assert {title: answer["status"] for title, answer in submitted.items()} == {
        "Review batches": "success",
        "Review single-under-batches": "success",
        "Review samples": "success",
        "Review samples-again": "success",
        "Review batch-under-samples": "success",
        "Review single-under-samples": "success",
    }
    samples = ["Review samples", "Review samples-again", "Several samples", "One more look"]
    # module: the menu's own case list, under a parent with the parent's selection kept.
    assert landed["Review batches"] == {"kind": "entities", "title": "Batches", "commands": []}
    assert landed["Review samples-again"] == {"kind": "entities", "title": "Samples", "commands": []}
    assert landed["Review batch-under-samples"] == {"kind": "entities", "title": "Several samples", "commands": []}
    # firstMenu: the app's first screen, listing its menus.
    assert landed["Review single-under-batches"] == {
        "kind": "commands",
        "title": "Batch reviews",
        "commands": ["Batches", "Samples"],
    }
    # parentMenu: the parent menu with its selection kept, listing its forms and child menus.
    assert landed["Review single-under-samples"] == {"kind": "commands", "title": "Samples", "commands": samples}
    # previous: the screen before the form, the top-level menu's list of forms after its case.
    assert landed["Review samples"] == {"kind": "commands", "title": "Samples", "commands": samples}


ENTRY_POINTS = {
    # Entry point: where Formplayer lands. A form opens; one off the menu opens only where its entry point ignores
    # display conditions, and otherwise lands on the menu that holds it, or on the app's first screen when that
    # menu is off the menu too.
    "shown_form": {"kind": "form", "title": "Shown", "commands": []},
    "hidden_rest": {"kind": "form", "title": "Hidden with rest", "commands": []},
    "hidden_plain": {"kind": "commands", "title": "Targets", "commands": ["Shown"]},
    "inside": {"kind": "form", "title": "Inside", "commands": []},
    "inside_plain": {"kind": "commands", "title": "Hidden menus", "commands": ["Start", "Targets"]},
}


def test_an_item_off_the_menu_is_listed_nowhere_and_opens_from_a_link_or_entry_point_as_web_apps_allows(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    with apps.published(formplayer_documents[HIDDEN], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            submitted = _submitted(apps.walked(formplayer_runner, served))
            with served.run("menus"):
                web = apps.web(formplayer_runner, served)
                menus = {"first": _landing(web.navigate([])), "targets": _landing(web.navigate(["1"]))}
            entered = {}
            for endpoint in ENTRY_POINTS:
                with served.run(f"endpoint-{endpoint}"):
                    web = apps.web(formplayer_runner, served)
                    entered[endpoint] = _landing(
                        web.navigate([], route="get_endpoint", endpoint_id=endpoint, endpoint_args={})
                    )
    landed = {title: _landing(answer["nextScreen"]) for title, answer in submitted.items()}
    evidence("hidden-from-menu", {"menus": menus, "links": landed, "entryPoints": entered})

    # Row 1: neither hidden form nor the hidden menu is listed.
    assert menus == {
        "first": {"kind": "commands", "title": "Hidden menus", "commands": ["Start", "Targets"]},
        "targets": {"kind": "commands", "title": "Targets", "commands": ["Shown"]},
    }
    # Rows 2 and 3: a link to a hidden form lands on the menu that holds it; a link into the hidden menu on the
    # app's first screen. Both submissions are saved.
    assert submitted["To hidden form"]["status"] == submitted["To inside"]["status"] == "success"
    assert landed["To hidden form"] == {"kind": "commands", "title": "Targets", "commands": ["Shown"]}
    assert landed["To inside"] == {"kind": "commands", "title": "Hidden menus", "commands": ["Start", "Targets"]}
    # Rows 5 and 6, and the shown form's entry point.
    assert entered == ENTRY_POINTS
