"""Workers see the pinned Formplayer activity record of a real released form."""

from proof.formplayer import apps
from proof.formplayer.hq import PASSWORD, sign_in
from proof.formplayer.walk import questions, screen_kind
from proof.formplayer.webapps import WebApps

DOCUMENT = "targeted-web-form-activity"


def _open_visit(web):
    selected = []
    for _ in range(4):
        response = web.navigate(selected)
        if screen_kind(response) == "form":
            return response
        commands = [row["displayText"] for row in response["commands"]]
        title = next(label for label in ("Clinics", "Report a visit") if label in commands)
        selected = [*map(str, response.get("selections", selected)), str(commands.index(title))]
    raise AssertionError("The released visit did not open")


def _as_worker(served, runner, name):
    from corehq.apps.users.models import CommCareUser
    from corehq.apps.users.util import format_username

    with served.unit.committing():
        worker = CommCareUser.create(
            served.domain, format_username(name, served.domain), PASSWORD,
            created_by=None, created_via=None,
        )
    signed = sign_in(served.unit, worker, PASSWORD, name)
    return WebApps(
        runner, served.hq, domain=served.domain, username=worker.username,
        app_id=served.build_id, session_key=signed.session,
    )


def test_activity_uses_the_opening_key_and_the_viewing_workers_sync(
    hq, core_runner, formplayer_runner, formplayer_documents, evidence,
):
    with apps.published(formplayer_documents[DOCUMENT], core_runner) as published, apps.served(
        published, formplayer_runner,
    ) as served, served.run("view-activity"):
        first = apps.web(formplayer_runner, served)
        second = _as_worker(served, formplayer_runner, "activity-second")
        later = _as_worker(served, formplayer_runner, "activity-later")

        def activate(worker):
            served.hq.session_key = worker.session_key
            return worker

        entered = _open_visit(activate(first))
        assert entered.get("notification") is None
        next_entry = _open_visit(activate(second))
        opened = next_entry["notification"]["message"]
        assert "recently started this form for Northern clinic" in opened, next_entry
        assert "out of date" not in opened

        note = list(questions(entered["tree"]))[0]
        sent = activate(first).submit(entered["session_id"], {note["ix"]: "Different worker answer"})
        assert sent["status"] == "success", sent
        observed = _open_visit(activate(second))
        submitted = observed["notification"]["message"]
        assert "recently submitted this form for Northern clinic" in submitted, observed
        assert "Your data may be out of date!" in submitted, observed
        fresh = _open_visit(activate(later))
        assert fresh.get("notification") is None, fresh
        evidence("activity", {"opened": opened, "submitted": submitted, "fresh": fresh.get("notification")})
