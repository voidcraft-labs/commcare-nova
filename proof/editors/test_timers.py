"""A run that counts its pages' short timers settles only once they and what they start have run.

Contract (``driver/steps/page/timers.js``, the driver's ``settle`` step with
``timers``): every document of a run opened with ``timers`` counts each
one-off timer shorter than a second from the moment the page sets it until it
runs or is cleared, and a ``settle`` with ``timers`` returns only once none is
still set and none of the page's requests is in flight, both at once; a longer
timer is not waited for, and a run opened without ``timers`` counts nothing.
The Web Apps client sends a throttled answer from such a timer, and a step
that went on while it was set made what the client submitted depend on the
runner's speed. The plausible failures: a settle that returns while a short
timer is still set, or before the request a timer started has been answered
(a timer that sets another, as a throttle's trailing call does after a
debounce); a cleared timer still counted, so a settle never returns; a long
timer waited for (a notification's fade); and pages that count timers in a
run that never asked for it.

The client's progress bar (HQ's own nprogress, loaded from HQ's checkout) is
not waited for: its trickle re-arms itself every 800 ms while it shows, and
runs once more after it is done. The plausible failures: the bar's timers
counted, so a settle with the bar showing never returns and every step after
a request waits out the trickle; and a page's own short timer set beside the
bar left uncounted with them.
"""

from __future__ import annotations

import os
from pathlib import Path

from proof.editors.client import EditorDriver, PageResponse

# HQ's own copy of the progress bar its Web Apps client bundles (``cloudcare/js/utils.js`` imports it).
NPROGRESS = Path(os.environ.get("PROOF_HQ", "/opt/hq"), "node_modules", "nprogress", "nprogress.js")

# Far past any settle, and a second or more: a timer the settle does not wait for.
LONG_MS = 20_000
PAGE = f"""<!doctype html>
<script>
window.done = false;
window.long = false;
// A short timer that sets another, whose request the settle waits for too.
setTimeout(() => setTimeout(() => fetch("/a/proof/late/").then(() => {{ window.done = true; }}), 200), 200);
// Short timers cleared before they run, by each of the two calls that clear one.
const cleared = setTimeout(() => {{ window.ranCleared = true; }}, 500);
clearTimeout(cleared);
const clearedAsInterval = setTimeout(() => {{ window.ranCleared = true; }}, 500);
clearInterval(clearedAsInterval);
setTimeout(() => {{ window.long = true; }}, {LONG_MS});
</script>
<p>HQ</p>"""


# The bar (drawn into the page's body, which the page therefore has first) started as the client starts it around a
# request and left showing, so its trickle re-arms itself every 800 ms for as long as the page lives, then a short
# timer of the page's own once the request is answered, which the settle still waits for.
BAR_PAGE = """<!doctype html>
<p>HQ</p>
<script src="/a/proof/nprogress.js"></script>
<script>
window.done = false;
NProgress.start();
fetch("/a/proof/answer/").then(() => {
  setTimeout(() => { window.done = true; }, 200);
});
</script>"""


def _answer(asked, page=PAGE):
    def answer(request):
        asked.append(request.url)
        if request.url.endswith("/a/proof/apps/"):
            return PageResponse(200, [("Content-Type", "text/html; charset=utf-8")], page.encode())
        if request.url.endswith("/a/proof/nprogress.js"):
            return PageResponse(200, [("Content-Type", "text/javascript")], NPROGRESS.read_bytes())
        return PageResponse(200, [("Content-Type", "application/json")], b"{}")

    return answer


READ = {
    "eval": "() => [window.done, window.long, window.ranCleared === true,"
    " typeof window.proofShortTimers === 'function' ? window.proofShortTimers() : null]"
}


def test_a_settle_on_timers_waits_for_short_timers_and_their_requests_and_not_for_a_long_one():
    asked = []
    with EditorDriver() as driver:
        result = driver.run(
            [{"goto": "/a/proof/apps/"}, {"settle": True, "timers": True}, READ],
            answer=_answer(asked),
            deadline=40,
            timers=True,
        )
    done, long, ran_cleared, pending = result["outcomes"][-1]["value"]
    assert result["pageErrors"] == []
    # The chained short timers ran and the request the second started was answered before the settle returned.
    assert done is True
    assert "http://hq.proof.test/a/proof/late/" in asked, asked
    # The long timer is still set, and not counted; the cleared ones never ran and are not counted either.
    assert long is False
    assert ran_cleared is False
    assert pending == 0


def test_a_run_that_does_not_ask_counts_no_timers():
    asked = []
    with EditorDriver() as driver:
        result = driver.run(
            [{"goto": "/a/proof/apps/"}, {"waitFor": "window.done === true"}, READ],
            answer=_answer(asked),
            deadline=40,
        )
    done, long, ran_cleared, pending = result["outcomes"][-1]["value"]
    assert result["pageErrors"] == []
    # The page's timers run as the browser runs them, and nothing counts them.
    assert done is True
    assert long is False
    assert ran_cleared is False
    assert pending is None


def test_a_settle_waits_for_the_pages_own_short_timer_and_not_for_the_progress_bars():
    asked = []
    read = {"eval": "() => [window.done, NProgress.status, window.proofShortTimers()]"}
    with EditorDriver() as driver:
        result = driver.run(
            [
                {"goto": "/a/proof/apps/"},
                {"waitFor": "window.NProgress !== undefined"},
                {"settle": True, "timers": True},
                read,
            ],
            answer=_answer(asked, BAR_PAGE),
            deadline=40,
            timers=True,
        )
    done, status, pending = result["outcomes"][-1]["value"]
    assert result["pageErrors"] == []
    # The page's own timer, set once the request was answered, ran before the settle returned.
    assert done is True
    assert "http://hq.proof.test/a/proof/answer/" in asked, asked
    # The bar still shows, its trickle set again and again, and the settle returned with nothing of the page's own
    # pending.
    assert isinstance(status, float)
    assert pending == 0
