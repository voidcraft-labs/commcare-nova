"""Formplayer over Nova's local archive: it installs and runs it, submits its forms and searches as HQ's build does.

Contract: Nova compiles a local ``.ccz`` for the project space the app is
published to, so its profile names where a form is sent
(``PostURL``, which ``session/MenuSession.java`` reads and
``FormSession.getPostUrl`` hands the submit) and its suite names where a
search is sent, each under the working app's id. Formplayer installs the
archive as it installs HQ's build, shows the same menus and opens the same
form; its submit answers ``success`` and HQ's receiver takes the form at
``/a/<domain>/receiver/<A's id>/``, and its search reaches HQ at
``/a/<domain>/phone/search/<A's id>/``. The lane's archive names the
capture's placeholder app, which the harness writes A's id into before any
reader takes it (``proof.hq.operations.with_runtime_app_id``), as the
deployment's archive names it.

The paired refusal is a control's pre-fix archive
(``proof/controls/targeted-search-hq-compile/local.ccz``), whose profile
names no ``PostURL`` and whose search URL names ``__APP_ID__``: its submit
answers an error and HQ receives nothing, and its search reaches HQ under
``__APP_ID__``, which HQ receives at that placeholder; its older date filter is refused with a 400.
``targeted-form-link-hidden-target`` has no control of its own (its
``-after-59`` control is retained after these bytes and submits), so its
document's archive is the only one its test reads.

Every request Formplayer makes of HQ is answered by HQ's own views over one
served state (``proof.formplayer.hq``), each archive handed to Formplayer as
bytes where it asks HQ's download for it, since HQ does not hold it.

Plausible failures: a harness that could not install a local archive at all
(nothing would be learned about it), one that swallowed the submission or
the search (the build's submit and search show HQ's views processing them),
and an archive that names another app than the one HQ holds.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.hq.operations import with_runtime_app_id

# The retained controls (``proof/controls/``), whose pre-fix archives are the paired refusal.
CONTROLS_DIR = Path(__file__).resolve().parents[1] / "controls"
DOCUMENT = "targeted-form-link-hidden-target"
SEARCH_DOCUMENT = "targeted-search-hq-compile"
FIRST_FORM = ["0", "0"]
SEARCH = ["0", "action 0"]
ONE_MARK = "it's"


def _profile(archive: bytes) -> dict[str, str]:
    """The profile's properties, by key, read under the profile's namespace or none."""
    with zipfile.ZipFile(io.BytesIO(archive)) as held:
        return _profile_properties(held.read("profile.ccpr"))


def _profile_properties(source: bytes) -> dict[str, str]:
    """The properties of a profile XML document, as kept in HQ's build or an archive."""
    root = etree.fromstring(source)
    return {
        element.get("key"): element.get("value")
        for element in root.iter(etree.Element)
        if etree.QName(element).localname == "property"
    }


def _enter_and_submit(web, selections):
    menu = web.navigate(selections[:1])
    form = web.navigate(selections)
    assert screen_kind(form) == "form"
    (question,) = [node for node in form["tree"] if node["type"] == "question"]
    answered = web.answer(form["session_id"], question["ix"], "fed")
    assert answered["status"] == "accepted"
    submitted = web.submit(form["session_id"], {question["ix"]: "fed"})
    return [command["displayText"] for command in menu["commands"]], form["title"], submitted


def _first_form(web):
    """The first form a worker reaches from the home screen: the first menu, its first case, its first form."""
    selections = ["0"]
    screen = web.navigate(selections)
    while screen_kind(screen) != "form":
        kind = screen_kind(screen)
        if kind == "entities":
            selections.append(screen["entities"][0]["id"])
        elif kind == "commands":
            selections.append("0")
        else:
            raise AssertionError(f"The walk to the first form met a {kind} screen at {selections}: {screen}")
        screen = web.navigate(selections)
    return screen


def _submit_first_form(web):
    form = _first_form(web)
    answers = {node["ix"]: "fed" for node in form["tree"] if node["type"] == "question"}
    return web.submit(form["session_id"], answers)


def _search(web):
    screen = web.navigate(SEARCH)
    assert screen_kind(screen) == "query"
    return web.navigate(SEARCH, query_data={screen["queryKey"]: {"inputs": {"owner_id": ONE_MARK}, "execute": True}})


def test_formplayer_submits_a_local_archives_form_to_hqs_receiver_under_the_working_app(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    document = formplayer_documents[DOCUMENT]
    with apps.published(document, core_runner) as published:
        local = with_runtime_app_id(document.local_ccz.read_bytes(), published.app_id)
        local_id = apps.build_id(published.app_id, local)
        with apps.served(published, formplayer_runner) as served:
            served.hq.archives[local_id] = local
            with served.run("build"):
                built = _enter_and_submit(apps.web(formplayer_runner, served), FIRST_FORM)
                build_submissions = list(served.hq.submissions)
            with served.run("local"):
                from_local = _enter_and_submit(apps.web(formplayer_runner, served, app_id=local_id), FIRST_FORM)
                local_submissions = served.hq.submissions[len(build_submissions) :]
            received = [(asked.url_name, asked.status) for asked in served.hq.exchanges if asked.wrote]
            domain = served.domain
        evidence(
            "local-archive",
            {
                "build": {"submit": built[2]["status"], "paths": [s.path for s in build_submissions]},
                "local": {"submit": from_local[2]["status"], "paths": [s.path for s in local_submissions]},
            },
        )
        receiver = f"/a/{domain}/receiver/{published.app_id}/"
        # The local profile names the working app's receiver, as the profile HQ writes for that app does.
        assert _profile(local)["PostURL"].endswith(receiver)
        assert _profile_properties(published.build.files["profile.ccpr"])["PostURL"].endswith(receiver)
        # Both installs show the same menu and open the same form, and both submit.
        assert built[:2] == from_local[:2] == (["To shown form", "To hidden form", "To hidden menu"], "To shown form")
        assert built[2]["status"] == from_local[2]["status"] == "success"
        assert len(build_submissions) == 1
        assert [submission.path for submission in local_submissions] == [receiver]
        assert received.count(("receiver_post_with_app_id", 201)) == 2


def test_a_local_archives_search_reaches_hq_under_the_working_app_and_a_pre_fix_archives_does_not(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    document = formplayer_documents[SEARCH_DOCUMENT]
    control = (CONTROLS_DIR / SEARCH_DOCUMENT / "local.ccz").read_bytes()
    survey = (CONTROLS_DIR / "targeted-survey-menu" / "local.ccz").read_bytes()
    with apps.published(document, core_runner) as published:
        local = with_runtime_app_id(document.local_ccz.read_bytes(), published.app_id)
        local_id, control_id = apps.build_id(published.app_id, local), apps.build_id(published.app_id, control)
        survey_id = apps.build_id(published.app_id, survey)
        with apps.served(published, formplayer_runner) as served:
            served.hq.archives[local_id] = local
            served.hq.archives[control_id] = control
            served.hq.archives[survey_id] = survey
            with served.run("local-search"):
                _search(apps.web(formplayer_runner, served, app_id=local_id))
                local_searches = [search.path for search in served.hq.searches]
            with served.run("control-search"):
                first = len(served.hq.exchanges)
                _search(apps.web(formplayer_runner, served, app_id=control_id))
                control_asked = [(asked.path, asked.status) for asked in served.hq.exchanges[first:]]
            with served.run("control-submit"):
                before = len(served.hq.submissions)
                control_submit = _submit_first_form(apps.web(formplayer_runner, served, app_id=survey_id))
                control_submissions = served.hq.submissions[before:]
            domain = served.domain
        evidence(
            "local-archive-search",
            {
                "local": {"searches": local_searches},
                "control": {
                    "asked": control_asked,
                    "submit": control_submit["status"],
                    "submissions": len(control_submissions),
                },
            },
        )
        # The local archive's search reaches HQ under the working app's id.
        assert local_searches and set(local_searches) == {f"/a/{domain}/phone/search/{published.app_id}/"}
        # The pre-fix search asks for the placeholder app and carries a date filter HQ refuses with a 400.
        # The survey control names no submission URL, so its submit answers an error and HQ receives nothing.
        assert (f"/a/{domain}/phone/search/__APP_ID__/", 400) in control_asked
        assert "PostURL" not in _profile(survey)
        assert control_submit["status"] == "error" and control_submit["notification"]["error"] is True
        assert control_submissions == []
