"""Pinned Web Apps renders the worker-facing wording and the ordinary video control."""

import json

from proof.formplayer import apps
from proof.formplayer.test_itext_recipients import with_recipient_forms
from proof.formplayer.walk import Walk
from proof.webapps import hq as webapps_hq
from proof.webapps import observe, steps
from proof.webapps.session import Session
from proof.webapps.test_media_slots import DOCUMENT, LABEL_VIDEO


def test_web_apps_uses_long_recipients_and_only_the_ordinary_video(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        change = apps.form_written(project, {
            "0.0": lambda source: with_recipient_forms(source, "jr://file/commcare/inline-proof.mp4"),
        })
        with project.released(formplayer_runner, change=change) as release:
            walk = Walk.of(release)
            (run,) = [each for each in walk.run()["runs"] if any("answers" in step for step in each["steps"])]
            session = Session(release, editor_driver)
            made, kinds = observe.replay(release.doc["name"], [run], session.home)
            answer = kinds.index(("answer", 0, 0))
            before = session.run([
                *made[:answer],
                steps.SCREEN,
                *steps.click("#webforms .help-text-trigger", visible=True),
                {"eval": '() => document.querySelector("#webforms .modal.show")?.textContent'},
            ])
            after_first = answer + 3
            after = session.run([
                *made[:after_first], steps.SCREEN, *made[after_first:],
            ])
    assert before.page_errors == after.page_errors == []
    forms = [screen["form"] for screen in after.screens if screen.get("form")]
    evidence("itext-recipients", {"forms": forms, "help": before.value(-1)})
    assert "The address help" in before.value(-1)
    captions = json.dumps(forms)
    for wording in (
        "The address label", "The address hint", "The address violation",
        "The household title", "The chosen option", "The entries title",
    ):
        assert wording in captions, (wording, forms)
    assert LABEL_VIDEO in captions and "inline-proof.mp4" not in captions
