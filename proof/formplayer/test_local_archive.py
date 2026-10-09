"""Formplayer over Nova's local archive: it installs and runs it, and cannot submit its forms (finding 59).

Contract: Formplayer installs Nova's local ``.ccz`` as it installs HQ's
build, shows the same menus and opens the same form, and takes its answers;
its submit then answers an error and sends HQ nothing, since the local
profile names no submission URL (``PostURL``, which
``session/MenuSession.java`` reads and ``FormSession.getPostUrl`` hands the
submit). The same form of HQ's build of the same document submits, which is
the accepted case. So Formplayer's sessions are walked on HQ's builds, and
the two export paths are compared on Formplayer only up to a form's entry.

Every request Formplayer makes of HQ is answered by HQ's own views over one
served state (``proof.formplayer.hq``), Nova's local archive handed to
Formplayer as bytes where it asks HQ's download for it, since HQ does not
hold it.

Plausible failures: a harness that could not install a local archive at all
(nothing would be learned about it), or one that swallowed the submission
(the accepted case shows HQ's receiver processing it).
"""

from __future__ import annotations

import io
import zipfile

from lxml import etree

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind

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
        local = document.local_ccz.read_bytes()
        local_id = apps.build_id(published.app_id, local)
        with apps.served(published, formplayer_runner) as served:
            served.hq.archives[local_id] = local
            with served.run("build"):
                with_url = _enter_and_submit(apps.web(formplayer_runner, served), FIRST_FORM)
                build_submissions = list(served.hq.submissions)
            with served.run("local"):
                without = _enter_and_submit(apps.web(formplayer_runner, served, app_id=local_id), FIRST_FORM)
                local_submissions = served.hq.submissions[len(build_submissions) :]
            received = [(asked.url_name, asked.status) for asked in served.hq.exchanges if asked.wrote]
        evidence(
            "local-archive",
            {
                "build": {"submit": with_url[2]["status"], "submissions": len(build_submissions)},
                "local": {
                    "submit": without[2]["status"],
                    "notification": without[2]["notification"],
                    "submissions": len(local_submissions),
                },
            },
        )
        # The profiles differ in what the submit reads.
        assert "PostURL" in _profile_keys(published.build.files["profile.ccpr"])
        with zipfile.ZipFile(io.BytesIO(local)) as held:
            assert "PostURL" not in _profile_keys(held.read("profile.ccpr"))
        # Both installs show the same menu and open the same form.
        assert with_url[:2] == without[:2] == (["To shown form", "To hidden form", "To hidden menu"], "To shown form")
        # The accepted case: HQ's build submits, and HQ's receiver processes the form.
        assert with_url[2]["status"] == "success" and len(build_submissions) == 1
        assert ("receiver_post_with_app_id", 201) in received
        # The local archive: an error, and HQ receives nothing.
        assert without[2]["status"] == "error" and without[2]["notification"]["error"] is True
        assert local_submissions == []
