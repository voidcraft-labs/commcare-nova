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
"""

from __future__ import annotations

from proof.editors.client import EditorDriver, PageResponse

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


def _answer(asked):
    def answer(request):
        asked.append(request.url)
        if request.url.endswith("/a/proof/apps/"):
            return PageResponse(200, [("Content-Type", "text/html; charset=utf-8")], PAGE.encode())
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
