"""A page the driver opens holds its polls, and runs every other timer as the browser does.

Contract (``driver/steps/page/polls.js``): every document of every page the
driver opens, seeded or not, registers a repeating timer of ``POLL_MS`` or
longer and never runs it, so what a run asks HQ never depends on how long
the run took on the machine (HQ's app manager asks ``current_app_version``
every 20 seconds: ``app_manager/js/menu.js``). A shorter repeating timer
and a one-off timer of any length run. The plausible failures: a poll that
still reaches HQ in a slow run; a held timer whose id ``clearInterval``
refuses; and a hold that reaches further, stopping a short poll or a long
one-off timer a page needs.
"""

from __future__ import annotations

from proof.editors.client import EditorDriver, PageResponse

# Just below the hold (polls.js's POLL_MS): the control, a repeating timer the page runs.
SHORT_MS = 9_999
HELD_MS = 10_000
PAGE = f"""<!doctype html>
<script>
window.ticks = 0;
const held = setInterval(() => fetch("/a/proof/held/"), {HELD_MS});
setInterval(() => {{ window.ticks += 1; }}, 200);
setInterval(() => fetch("/a/proof/short/"), {SHORT_MS});
setTimeout(() => {{ window.late = true; }}, {HELD_MS + 500});
window.cleared = (() => {{ try {{ clearInterval(held); return true; }} catch (error) {{ return String(error); }} }});
</script>
<p>HQ</p>"""


def test_a_poll_of_ten_seconds_or_more_never_runs_and_every_other_timer_does():
    asked = []

    def answer(request):
        asked.append(request.url)
        if request.url.endswith("/a/proof/apps/"):
            return PageResponse(200, [("Content-Type", "text/html; charset=utf-8")], PAGE.encode())
        return PageResponse(200, [("Content-Type", "application/json")], b"{}")

    with EditorDriver() as driver:
        result = driver.run(
            [
                {"goto": "/a/proof/apps/"},
                # Past the held poll's first turn and the short one's: the one-off timer after both has run.
                {"waitFor": "window.late === true"},
                {"eval": "() => [window.ticks, window.cleared()]"},
            ],
            answer=answer,
            deadline=40,
        )
    ticks, cleared = result["outcomes"][-1]["value"]
    assert result["pageErrors"] == []
    assert cleared is True
    assert ticks >= 40, ticks
    assert "http://hq.proof.test/a/proof/short/" in asked, asked
    assert "http://hq.proof.test/a/proof/held/" not in asked, asked
