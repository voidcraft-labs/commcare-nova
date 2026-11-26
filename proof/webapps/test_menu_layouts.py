"""A worker chooses the same commands before and after HQ saves the layout.
Web Apps offers the same sound on a list row and omits it on a grid tile."""
import pytest

from proof.editors import pages
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


@pytest.mark.reader("webapps")
def test_grid_and_list_offer_their_commands_and_spoken_labels(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-menu-layouts"]
    with webapps_hq.project(document) as project:
        saves = ((pages.APP_SETTINGS, None), (pages.MODULE_SETTINGS, project.module_id(1)))
        for label, applied in (("published", ()), ("saved", saves)):
            with project.released(formplayer_runner, driver=editor_driver, saves=applied, label=label) as release:
                session = Session(release, editor_driver)
                for menu, form, offered, layout, audio in (
                    ("Services", "Record visit", ["Check supplies", "Record visit"], "grid", []),
                    ("Support", "Request help", ["Request help", "Leave a message"], "list", ["Request help"]),
                ):
                    run = session.run([
                        *steps.open_app("Community visits"), steps.SCREEN,
                        *steps.choose(menu), steps.SCREEN,
                        *steps.choose(form), steps.SCREEN,
                    ])
                    evidence(f"{label}-{menu}", run.screens)
                    assert run.page_errors == []
                    first, choices, opened = run.screens
                    assert first["menuLayout"] == "grid" and first["menuAudio"] == []
                    assert [choice["text"] for choice in first["commands"]] == ["Services", "Support"]
                    assert choices["menuLayout"] == layout and choices["menuAudio"] == audio
                    assert [choice["text"] for choice in choices["commands"]] == offered
                    assert opened["form"]["questions"], opened
