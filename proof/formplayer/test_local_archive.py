"""Formplayer over Nova's local archive: it installs and runs it, and cannot submit its forms (finding 59).

Contract: Formplayer installs Nova's local ``.ccz`` as it installs HQ's
build, shows the same menus and opens the same form, and takes its answers;
its submit then answers an error and sends HQ nothing, since the local
profile names no submission URL (``PostURL``, which
``session/MenuSession.java`` reads and ``FormSession.getPostUrl`` hands the
submit). The same form of HQ's build of the same document submits, which is
the accepted case. So Formplayer's sessions are walked on HQ's builds, and
the two export paths are compared on Formplayer only up to a form's entry.

Plausible failures: a harness that could not install a local archive at all
(nothing would be learned about it), or one whose HQ answers swallowed the
submission (the accepted case shows HQ receiving it).
"""

from __future__ import annotations

import io
import zipfile

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.observe.sessions import local_restore

DOCUMENT = "targeted-form-link-hidden-target"
FIRST_FORM = ["0", "0"]


def _profile_keys(profile: bytes) -> set[str]:
    return {element.get("key") for element in etree.fromstring(profile).iter("property")}


def _enter_and_submit(web, selections):
    menu = web.navigate(selections[:1])
    form = web.navigate(selections)
    assert screen_kind(form) == "form"
    (question,) = [node for node in form["tree"] if node["type"] == "question"]
    answered = web.answer(form["session_id"], question["ix"], "fed")
    assert answered["status"] == "accepted"
    submitted = web.submit(form["session_id"], {question["ix"]: "fed"})
    return [command["displayText"] for command in menu["commands"]], form["title"], submitted


def test_formplayer_runs_a_local_archive_up_to_its_forms_and_cannot_submit_one(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence
):
    document = formplayer_documents[DOCUMENT]
    with apps.published(document, core_runner) as published:
        built = apps.installed(published)
        local = document.local_ccz.read_bytes()
        local_id = apps.build_id(published.app_id, local)
        restore = local_restore(published.unit, built.database)
        answers = apps.answers(published.unit, built.database, {local_id: local}, restore)
        archive = apps.Installed(published.unit, built.database, local_id, local, restore, answers)

        with_url = _enter_and_submit(apps.web(formplayer_runner, built), FIRST_FORM)
        without = _enter_and_submit(apps.web(formplayer_runner, archive), FIRST_FORM)
        evidence(
            "local-archive",
            {
                "build": {"submit": with_url[2]["status"], "submissions": len(built.hq.submissions)},
                "local": {
                    "submit": without[2]["status"],
                    "notification": without[2]["notification"],
                    "submissions": len(answers.submissions),
                },
            },
        )
        # The profiles differ in what the submit reads.
        assert "PostURL" in _profile_keys(published.build.files["profile.ccpr"])
        with zipfile.ZipFile(io.BytesIO(local)) as held:
            assert "PostURL" not in _profile_keys(held.read("profile.ccpr"))
        # Both installs show the same menu and open the same form.
        assert with_url[:2] == without[:2] == (["To shown form", "To hidden form", "To hidden menu"], "To shown form")
        # The accepted case: HQ's build submits, and HQ receives the form.
        assert with_url[2]["status"] == "success" and len(built.hq.submissions) == 1
        # The local archive: an error, and HQ receives nothing.
        assert without[2]["status"] == "error" and without[2]["notification"]["error"] is True
        assert answers.submissions == []
