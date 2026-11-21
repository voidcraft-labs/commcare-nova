"""Only the missing picture of the command both native readers showed can explain the change."""

import copy
from dataclasses import replace

import pytest

from proof.checks import broken_menu_images as pictures
from proof.checks.differences import Difference

URI = "jr://file/commcare/image/patient.png"
URL = "/hq/multimedia/file/CommCareImage/missing/patient.png"
READ = {"path": URI, "mediaType": "CommCareImage", "multimediaId": "missing", "status": 404}
SOURCE = {
    "multimedia_map": {URI: {"media_type": "CommCareImage", "multimedia_id": "missing"}},
    "modules": [{"forms": [{"media_image": {"en": URI}}]}],
}


def state(image, icon):
    choice = {"command": "m0-f0", "text": "Visit", "image": image}
    core = {"runs": [{"trace": [{"screen": "menu", "root": "root", "choices": [choice]}]}]}
    row = {"index": 0, "displayText": "Visit", "navigationState": "JUMP"}
    if image:
        row["imageUri"] = image
    step = {"request": {"selections": []}, "response": {"selections": [], "type": "commands", "commands": [row]}}
    formplayer = {"runs": [{"steps": [step]}]}
    command = {"text": "Visit", "image": URL if image else None, "icon": icon}
    web = {"runs": [{"screens": [{"route": {"selections": []}, "commands": [command]}]}]}
    return (core, formplayer), web


def diff(artifact, path, before, after):
    return Difference(
        "proof3",
        "doc",
        artifact,
        path,
        path.replace("*", "0"),
        "removed" if artifact.startswith("formplayer") else "changed",
        before,
        after,
    )


FP = diff("formplayer@local.ccz", pictures.FORMPLAYER_IMAGE, URI, None)
WEB_IMAGE = diff("webapps@B", pictures.WEB_IMAGE, URL, None)
WEB_ICON = diff("webapps@B", pictures.WEB_ICON, None, "fa-pencil")


@pytest.mark.parametrize(
    "reads", [[], [{**READ, "status": 200}], [{**READ, "multimediaId": "other"}], [READ, {**READ, "status": 200}]]
)
def test_a_stored_reference_alone_does_not_prove_its_image_is_broken(reads):
    assert pictures.missing_images(SOURCE, reads) == {}


def test_the_exact_source_image_and_both_chooser_rows_explain_only_their_observed_changes():
    old, browser_old = state(URI, None)
    new, browser_new = state(None, "fa-pencil")
    diffs = [FP, replace(FP, artifact="formplayer@B"), WEB_IMAGE, WEB_ICON]
    source = copy.deepcopy(SOURCE)

    def sites():
        return pictures.locations(
            diffs, source, pictures.missing_images(source, [READ]), old, new, web=(browser_old, browser_new)
        )

    wanted = {d.artifact: (d.artifact, d.at) for d in diffs}
    assert sites() == {(d.artifact, d.at): ("form", "0.0", "media_image") for d in diffs}
    # The default icon belongs to JUMP on this client. A change in the worker's action is separate.
    browser_new["runs"][0]["screens"][0]["commands"][0]["icon"] = "fa-folder"
    assert set(sites()) == {wanted["formplayer@B"], wanted["formplayer@local.ccz"]}
    browser_new["runs"][0]["screens"][0]["commands"][0]["icon"] = "fa-pencil"
    # Same picture on another surface, another HQ media id at the URL, and the same label on a different command.
    browser_old["runs"][0]["screens"][0]["commands"][0]["image"] = URL.replace("missing", "real")
    assert set(sites()) == {wanted["formplayer@B"], wanted["formplayer@local.ccz"]}
    browser_old["runs"][0]["screens"][0]["commands"][0]["image"] = URL
    browser_new["runs"][0]["screens"][0]["route"]["selections"] = ["0"]
    assert set(sites()) == {wanted["formplayer@B"], wanted["formplayer@local.ccz"]}
    source["modules"][0]["forms"][0]["media_image"]["en"] = URI + ".other"
    assert sites() == {}
    source["modules"][0]["forms"][0]["media_image"]["en"] = URI
    new[0]["runs"][0]["trace"][0]["choices"][0]["command"] = "m0-f1"
    assert sites() == {}


@pytest.mark.parametrize("slot", [None, URI, [URI], {"en": [URI]}, {"en": URI, "fra": "jr://file/other.png"}])
def test_an_unrecognized_or_ambiguous_source_slot_cannot_explain_a_removed_icon(slot):
    old, _ = state(URI, None)
    new, _ = state(None, "fa-pencil")
    source = copy.deepcopy(SOURCE)
    source["modules"][0]["forms"][0]["media_image"] = slot
    assert pictures.locations([FP], source, pictures.missing_images(source, [READ]), old, new) == {}


def test_malformed_native_choice_data_cannot_identify_the_command():
    old, _ = state(URI, None)
    new, _ = state(None, "fa-pencil")
    old[0]["runs"][0]["trace"][0]["choices"][0]["command"] = ["m0-f0"]
    assert pictures.locations([FP], SOURCE, pictures.missing_images(SOURCE, [READ]), old, new) == {}
