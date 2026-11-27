"""A signed worker's installed and browser choices follow an HQ owner-only edit."""

from dataclasses import replace

import pytest

from proof.android import observe
from proof.hq import operations
from proof.hq.test_lookup_upload import workbook
from proof.observe import casedata
from proof.observe.record import Blobs
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


VILLAGE_CHOICES = {
    "eval": """() => {
        const village = [...document.querySelectorAll("#webforms .q")].find(question =>
            question.querySelector(".caption, legend, label")?.textContent.trim() === "Village");
        if (!village) throw Error("Village is missing from the open form");
        const select = village.querySelector("select");
        if (select) {
            return [...select.options].filter(option => option.value).map(option => option.textContent.trim());
        }
        return [...village.querySelectorAll("input[type=radio]")].map(input =>
            input.labels[0].textContent.trim());
    }""",
}


def assigned_villages(visible):
    return workbook([
        (
            "types", ("Delete(Y/N)", "table_id", "is_global?", "field 1", "field 2", "field 3"),
            [("N", "villages", "no", "id", "name", "district")],
        ),
        (
            "villages", ("UID", "Delete(Y/N)", "field: id", "field: name", "field: district", "user 1", "group 1"),
            [
                (None, "N", "direct", "Direct clinic", "d1", casedata.USERNAME, ""),
                (None, "N", "east", "East clinic", "d1", "", "current team" if visible == "east" else "other team"),
                (None, "N", "west", "West clinic", "d1", "", "current team" if visible == "west" else "other team"),
            ],
        ),
    ])


def with_web_apps(configuration):
    return replace(configuration, privileges=configuration.privileges | {webapps_hq.WEB_APPS_PRIVILEGE})


@pytest.mark.parametrize("reader", [
    "webapps",
    pytest.param("android", marks=pytest.mark.reader("android")),
])
def test_signed_workers_restore_assigned_choice_changes_without_a_new_app_release(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence, reader,
):
    from corehq.apps.groups.models import Group

    document = webapps_documents["hq-lookups"]
    with webapps_hq.authored_project(document, "A", configure=with_web_apps) as project:
        app = operations.held_app(project.unit, project.app_id)
        app.cloudcare_enabled = True
        app.save()
        with project.released(formplayer_runner) as release:
            with project.unit.committing():
                for key, users in (("current", [release.worker.user_id]), ("other", [])):
                    project.unit.couch.seed({
                        **Group(domain=project.unit.domain, name=f"{key} team", users=users).to_json(),
                        "_id": f"assigned-lookup-{key}",
                    })
            archive = observe.release_archive(release)
            administrative = None
            for expected, heading in (("east", "East clinic"), ("west", "West clinic")):
                with project.unit.committing():
                    result = operations.upload_lookup_workbook(project.unit, assigned_villages(expected), replace=True)
                    assert result.errors == [], result.errors
                table = (
                    operations.served_lookup_tables(project.unit)["villages"],
                    operations.served_lookup_rows(project.unit, "villages", details=True),
                )
                if administrative is None:
                    administrative = table
                else:
                    assert table == administrative
                assert observe.release_archive(release) == archive

                if reader == "webapps":
                    survey = steps.click(steps.MENU_ROW, "Survey", visible=True, within=steps.WITHIN_MS)
                    web = Session(release, editor_driver).run([
                        *steps.open_app("Farm visits"), *steps.choose("Farm survey"), *survey,
                        *steps.arrive(form=True), *steps.answer("1", "1"), VILLAGE_CHOICES,
                    ])
                    observed = {"web": web.value(-1), "errors": web.page_errors, "dialogs": web.dialogs}
                    evidence(f"assigned-web-{expected}", observed)
                    assert not web.page_errors and not web.dialogs, observed
                    assert web.value(-1) == ["Direct clinic", heading], observed
                else:
                    blobs = Blobs()
                    native = observe.app(
                        release, blobs, label=f"assigned-{expected}", archive=archive, commands=["m0-f0"],
                        controls=True, questions={"/data/district": ["1"], "/data/village": ["1"]},
                    )
                    answer = blobs.get_json(native["answer"])
                    evidence(f"assigned-android-{expected}", answer)
                    assert answer["install"] == "Installed" and answer["signIn"].startswith("Success("), answer
                    trace = answer["walks"]["m0-f0"]
                    choices = [
                        question["control"]["choices"]
                        for step in trace["steps"] if "form" in step
                        for screen in step["form"]["screens"]
                        for question in screen["questions"]
                        if question["reference"] == "/data/village[1]" and "choices" in question.get("control", {})
                    ]
                    assert choices, trace
                    assert [choice["value"] for choice in choices[0]] == ["direct", expected], choices
