"""What a worker sees in Web Apps when they type a whitespace-only case name: the client's own invalid-answer text.

Nova guards a question a create reads as its case name with a constraint:
the trimmed answer is at least one character and at most 255
(``lib/commcare/xform/builder.ts``, ``lib/domain/caseScalarTextGuard.ts``).
Where the author wrote no validation message the form carries none, so
Formplayer answers the refused answer ``validation-error`` of type
``constraint`` with no reason, and the client shows its own text under the
question (``form_entry/form_ui.js``, ``session.reconcile``: "This answer is
outside the allowed range.").

Contract, on HQ's release of Nova's export of ``navigation-base``, whose form
"Register" names the new patient from its question "Name": a worker opens the
form from the app's menu, types three spaces into "Name" and presses Submit.
The page shows the client's own text under "Name" and under no other
question, the worker stays on the form, and HQ's receiver is sent nothing.
The lane's answer table types no whitespace-only name, so its replays never
reach the guard. Plausible failures: a guard the client never hears of (no
text, and a case made with a blank name), a message under another question,
and a submission the client sends all the same.
"""

from __future__ import annotations

from proof.webapps import hq as webapps_hq
from proof.webapps import steps
from proof.webapps.session import Session

DOCUMENT = "navigation-base"
# The form's first question, "Name", by the index the client writes for it.
NAME = "0"
OUTSIDE = "This answer is outside the allowed range."


def test_web_apps_shows_its_own_text_for_a_whitespace_only_name_and_sends_nothing(
    hq, core_runner, formplayer_runner, editor_driver, webapps_documents, evidence
):
    with webapps_hq.project(webapps_documents[DOCUMENT]) as project:
        with project.released(formplayer_runner) as release:
            session = Session(release, editor_driver)
            run = session.run(
                [
                    *steps.open_app(release.doc["name"]),
                    *steps.choose("Patients"),
                    *steps.choose("Register"),
                    *steps.answer(NAME, "   "),
                    steps.SCREEN,
                    *steps.submit_and_land(),
                    steps.SCREEN,
                ]
            )
            received = len(session.hq.submissions)
    typed, after = run.screens
    evidence("case-name-guard", {"typed": typed, "after": after, "submissions": received})
    assert run.page_errors == []
    assert typed["form"]["title"] == "Register", typed
    name, *others = typed["form"]["questions"]
    assert name["label"].startswith("Name"), typed["form"]["questions"]
    assert name["errors"] == [OUTSIDE], name
    assert all(not question["errors"] for question in others), others
    # Submit leaves the worker on the form, and the client sends HQ nothing.
    assert after["form"]["title"] == "Register", after
    assert all(exchange.json()["status"] != "success" for exchange in run.answered("submit-all"))
    assert received == 0
