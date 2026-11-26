"""Web Apps opens the ordinary case list when the app carries an Android lookup."""

from proof.observe import casedata
from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session


def test_web_apps_keeps_ordinary_cases_and_omits_the_android_lookup(
    hq, formplayer_runner, editor_driver, webapps_documents, evidence
):
    document = webapps_documents["targeted-case-list-device-lookup"]
    database = casedata.database_of_restore((document.root / "restore.xml").read_bytes())
    with webapps_hq.project(document) as project:
        with project.released(formplayer_runner, database=database) as release:
            short = release.doc["modules"][0]["case_details"]["short"]
            assert short["lookup_enabled"] and short["lookup_name"] == "Find a visit"
            run = Session(release, editor_driver).run([
                *steps.open_app("Case list lookup"),
                *steps.choose("Visits"),
                steps.SCREEN,
                *steps.select_case("lookup-cedar"),
                steps.SCREEN,
            ])
    assert not run.page_errors, run.page_errors
    case_list, form = run.screens
    evidence("android-lookup-ignored", case_list)
    assert "Find a visit" not in case_list["list"]["actions"]
    assert {row["id"] for row in case_list["list"]["rows"]} == {"row-lookup-cedar", "row-lookup-juniper"}
    assert form["form"]["questions"], form
