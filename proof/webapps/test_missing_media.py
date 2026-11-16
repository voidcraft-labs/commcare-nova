"""What a worker sees in Web Apps of a media reference with no file, on each slot a worker can meet one on.

``targeted-missing-media``: a survey "Visit" in the menu "Visits", whose question ``remarks`` names an image and a
sound, whose select ``answer`` names a sound on its first choice, whose question ``photo`` names an image, and
whose menu names an icon and whose form a sound; and a case list "Patients" whose image column maps every status to
a picture, offering "Register" from another menu under an icon. Nova publishes each with its file. The release here
is of the app with its files taken away as an app made in CommCare HQ can hold them
(``proof.formplayer.apps.with_missing_media``): the question's image, the sound and the picture the menu, the list
and the Register action share lose their multimedia map entries, and the file of ``photo``'s image is deleted from
the project space while its entry stays. Formplayer's own walk of the build is replayed in the browser
(``proof.webapps.observe.replay``), every run of it, so the client shows the home screen, the menu, the form and the
list.

Contract: the client finds a file's address in the app's multimedia map (``formplayer/app.js``, the
``resourceMap`` reply), so a reference with no entry has none. A question's picture is laid out only where it has
one (``form_entry/multimedia.html``: ``visible: mediaSrc(...)``), and its sound is laid out by its path, entry or
not (``visible: caption_audio``), a player with nothing to play; a choice's media never reaches the client
(Formplayer's ``PromptToJson.parseSelect`` sends each choice's text alone); a menu's and a form's icon show
nothing without an address (``menus/views.js``: ``imageUrl`` is the reply's answer, a background image), and the
Register action is a button with its label alone (``case_list/list.html``). A list's image cell is an ``<img>``
whatever its value (``case_list/item.html``: ``src`` the reply's answer, which the template prints empty where
there is none, and ``alt`` the value's alternative text). HQ's build writes that text for every value an image
column maps, as a no-break space where the app gives none (``app_strings.py``, under ``supports_alt_text``, and
``commcare_translations.py::dumps``), and a value that maps to no picture has none (the column's alternative text
falls to ``''``). So a case whose status maps to the picture with no entry gets an ``<img>`` with no address and a
no-break space for its text, which the browser draws as its stand-in for a picture it cannot show, and a case
whose status maps to no picture an ``<img>`` with no address and no text, which it draws nothing for: the same
cell, its counterpart. A reference whose entry stays has an address, so the client lays out ``photo``'s picture
at it, and the file is gone: a broken picture.

Plausible failures: a missing file the client draws something for where Nova reads the reference as inert, or one
it draws nothing for where Nova refuses it; and a page that names no media at all, which ``photo``'s picture,
laid out at its address, rules out.
"""

from __future__ import annotations

import json

from proof.formplayer import apps
from proof.webapps import hq as webapps_hq
from proof.webapps import observe
from proof.webapps.session import Session

DOCUMENT = "targeted-missing-media"


def test_web_apps_shows_a_player_for_a_missing_sound_and_a_broken_picture_in_the_list_and_for_a_deleted_file(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    from proof.formplayer.walk import Walk

    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner, change=apps.with_missing_media(project)) as release:
            runs = Walk.of(release).run()["runs"]
            session = Session(release, editor_driver)
            made, _ = observe.replay(release.doc["name"], runs, session.home)
            replayed = session.run(made, deadline=180.0 + 2.0 * len(made))
    screens = replayed.screens
    evidence("screens", screens)
    assert replayed.page_errors == []

    # No screen names a file that lost its entry: no picture, player, icon or cell points at one.
    whole = json.dumps(screens)
    for name in apps.MISSING_MEDIA_UNMAPPED:
        assert name not in whole, name

    # The menus and the form rows show no image, the menu's icon among them.
    commands = [command for screen in screens for command in screen.get("commands", ())]
    assert {command["text"] for command in commands} >= {"Visits", "Patients", "Visit"}, commands
    assert all(command["image"] is None for command in commands), commands

    forms = [screen["form"] for screen in screens if screen.get("form", {}).get("title") == "Visit"]
    assert forms, f"The client never showed the survey Visit of {DOCUMENT}: {screens}"
    for form in forms:
        questions = {question["label"]: question for question in form["questions"]}
        # The question's picture is not laid out; its sound is, as a player with no address.
        assert questions["Remarks"]["media"] == [{"kind": "audio", "src": None}], questions["Remarks"]
        # The choice's sound never reaches the client.
        assert questions["Answer"]["media"] == [], questions["Answer"]
        # The picture whose file is gone is laid out at the address its entry gives.
        (picture,) = questions["Photo"]["media"]
        assert picture["kind"] == "img", picture
        assert picture["src"].startswith("/hq/multimedia/file/CommCareImage/"), picture
        assert picture["src"].endswith(f"/{apps.MISSING_MEDIA_DELETED}"), picture

    lists = [screen["list"] for screen in screens if screen.get("list") is not None]
    patients = [shown for shown in lists if [header["text"] for header in shown["headers"]] == ["Name", "Status"]]
    assert patients, f"The client never showed the case list Patients of {DOCUMENT}: {lists}"
    drawn = []
    for shown in patients:
        assert shown["rows"], shown
        for row in shown["rows"]:
            name, status = row["cells"]
            # The name cell holds no picture; the status cell holds one with no address, a case whose status maps
            # to the picture with no entry and a case whose status maps to none alike.
            assert name["image"] is None and "drawn" not in name, row
            assert status["image"] == "", row
            drawn.append(status["drawn"])
        # The Register action is offered by its label alone.
        assert "Register" in shown["actions"], shown["actions"]
    # The browser draws its stand-in for the picture with no entry, and nothing for a status that maps to none.
    assert set(drawn) == {True, False}, drawn
