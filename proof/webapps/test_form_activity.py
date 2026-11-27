"""Independent signed browser profiles draw HQ's real cross-worker form notice."""

from dataclasses import replace

from proof.formplayer.hq import PASSWORD, sign_in
from proof.webapps import hq as webapps_hq, steps
from proof.webapps.session import Session

DOCUMENT = "targeted-web-form-activity"
NOTICE = {"eval": "() => document.querySelector('#cloudcare-notifications').innerText"}


def test_the_second_worker_sees_the_first_workers_open_in_web_apps(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence,
):
    from corehq.apps.users.models import CommCareUser
    from corehq.apps.users.util import format_username

    with webapps_hq.project(webapps_documents[DOCUMENT]) as project, project.released(
        formplayer_runner,
    ) as release, release.run("shared-form-activity"):
        begin = [
            *steps.open_app(release.doc["name"]), *steps.choose("Clinics"),
            *steps.choose("Report a visit"), *steps.arrive(form=True), NOTICE,
        ]
        first = Session(release, editor_driver)._run(begin, release.acting, deadline=90)
        assert "recently started this form" not in first.value(-1), first.outcomes
        assert not first.page_errors, first.page_errors

        with project.unit.committing():
            second_worker = CommCareUser.create(
                release.domain, format_username("activity-browser-second", release.domain), PASSWORD,
                created_by=None, created_via=None,
            )
        signed = sign_in(project.unit, second_worker, PASSWORD, "activity-browser-second")
        release.hq.session_key = signed.session
        second = replace(release, worker=second_worker)
        # Both browser contexts are fresh. The enclosing Served.run keeps the
        # same HQ state and the same real Formplayer activity cache.
        arrived = Session(second, editor_driver)._run(begin, second.acting, deadline=90)
        caption = arrived.value(-1)
        assert "recently started this form for Northern clinic" in caption, arrived.outcomes
        assert not arrived.page_errors, arrived.page_errors
        evidence("two-browser-activity", {"first": first.value(-1), "second": caption})
