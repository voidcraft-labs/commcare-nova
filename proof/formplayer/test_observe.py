"""The served states as part of a document's observation: the records the lane's unit writes.

Contract (``proof.observe.unit.observe_document``, ``proof.observe.served``):
each configuration's ``a`` record holds what Formplayer and the Web Apps
client made of A (the ``served`` hook), its ``b_aligned`` record Formplayer's
walk of Nova's local archive over HQ's state, and proof 4's record what they
made of B, each as blobs of canonical JSON; observing the document again
gives the same records.

Plausible failures: a served state observed outside the unit's operations
and requests (HQ would draw unseeded values and the record would differ run
to run), a record that names an id Formplayer, HQ or the browser drew, or a
walk that silently did not run where Core's did.

And what a run asks HQ does not depend on the runs before it: Formplayer
keeps what a query fetched for five minutes of the machine's time
(``caching.specs.*``), which a worker's ``clear_user_data`` leaves, so a
second observation of ``search-hidden-link`` started within five minutes of
the first read the case its end-of-form link fetches (HQ's
``case_fixture``) from the first's cache and asked HQ nothing, while one
started later asked: a hosted run recorded both for one key. Each run starts
with Formplayer's caches empty (``FormplayerRunner.forget_caches``), so both
walks ask. That contract and the remote resource's are Formplayer's walk
alone, so those tests walk the served state with Formplayer and nothing
else (``proof.formplayer.apps``), where a whole observation would also show
every state to the client in three windows.
"""

from __future__ import annotations

import json

import pytest

from proof.formplayer import apps
from proof.formplayer.walk import screen_kind
from proof.observe.unit import observe_document

DOCUMENT = "targeted-form-link-hidden-target"
# A search whose results a form's end-of-form link fetches again by the case chosen (HQ's case_fixture).
FETCHED_AGAIN = "search-hidden-link"
# A form HQ builds that Core cannot install from the archive, so Formplayer reads it at its remote location.
REMOTE_RESOURCE = "targeted-invalid-question-ids"


def _served(found):
    held = found.configurations["minimum"]
    return held.a["hooks"]["served"], held.b_aligned["served"], held.b["proof4"]["served"]


def _opened(value, blobs):
    """``value`` with every blob it names that holds JSON read in its place, so two records that differ say where
    inside a blob they do."""
    if isinstance(value, dict):
        return {key: _opened(item, blobs) for key, item in value.items()}
    if isinstance(value, list):
        return [_opened(item, blobs) for item in value]
    if isinstance(value, str) and value.startswith("sha256:"):
        try:
            return _opened(blobs.get_json(value), blobs)
        except (KeyError, ValueError):
            return value
    return value


def _differences(a, b, path=""):
    """Each place where ``a`` and ``b`` differ, by its path, with both values' start."""
    if isinstance(a, dict) and isinstance(b, dict):
        keys = sorted(set(a) | set(b), key=str)
        return [found for key in keys for found in _differences(a.get(key), b.get(key), f"{path}/{key}")]
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        return [
            found
            for index, pair in enumerate(zip(a, b, strict=True))
            for found in _differences(*pair, f"{path}/{index}")
        ]
    if a == b:
        return []
    return [f"{path}: {json.dumps(a, sort_keys=True)[:300]} != {json.dumps(b, sort_keys=True)[:300]}"]


def _same_served(first, again):
    """Asserts two observations of one document served the same states, naming each place inside their blobs
    where they do not."""
    before, after = _served(first), _served(again)
    if before != after:
        found = _differences(_opened(list(before), first.blobs), _opened(list(after), again.blobs))
        raise AssertionError("Two observations of one document served it differently:\n" + "\n".join(found[:40]))


def _same_parts(first, again):
    """Asserts two observations of one document recorded the same parts, naming each place inside a part that
    differs (its blobs read in place)."""
    before, after = first.digests(), again.digests()
    found = []
    for name in sorted(set(before) | set(after)):
        if before.get(name) == after.get(name):
            continue
        if name == "local":
            parts = first.local, again.local
        else:
            configuration, part = name.split("/")
            parts = (getattr(found_.configurations[configuration], part) for found_ in (first, again))
        a, b = parts
        found += [f"{name}{line}" for line in _differences(_opened(a, first.blobs), _opened(b, again.blobs))]
    if found:
        raise AssertionError("Two observations of one document recorded different parts:\n" + "\n".join(found[:40]))


@pytest.mark.reader("webapps")  # beside Formplayer, which its fixture starts: it reads the client's record too
@pytest.mark.under_determinism
def test_a_documents_observation_holds_what_formplayer_and_the_client_made_of_each_state_and_the_same_on_every_run(
    hq, core_runner, editor_driver, formplayer_runner, formplayer_documents
):
    document = formplayer_documents[DOCUMENT]
    first = observe_document(document, core_runner=core_runner, editor_driver=editor_driver)
    at_a, aligned, at_b = _served(first)
    assert at_a["served"] and at_a["runtime"] == formplayer_runner.ready["formplayer"]
    # Formplayer walked A where Core's sessions ran on it, and HQ's receiver took every form it submitted.
    sessions = first.configurations["minimum"].b_aligned["sessions"]
    core = first.blobs.get_json(sessions["baseline"]["trace"])
    trace = first.blobs.get_json(at_a["A"]["formplayer"]["trace"])
    assert len(trace["runs"]) == len(core["runs"]) == 4
    assert [run["end"] for run in trace["runs"]] == ["submitted"] * 4
    assert at_a["A"]["formplayer"]["asked"]["receiver_post_with_app_id"] == 4
    assert at_a["A"]["formplayer"]["hq"] == [] and "releaseDiffers" not in at_a["A"]
    forms = [
        step["response"]["title"]
        for run in trace["runs"]
        for step in run["steps"]
        if screen_kind(step.get("response")) == "form"
    ]
    assert forms == [run["trace"][-1]["title"] for run in core["runs"]]
    # The client showed the same walk, the local archive was walked over HQ's state, and B was served for proof 4.
    # Each run in each of the client's windows: a desktop's, a phone's and App Preview's.
    assert len(first.blobs.get_json(at_a["A"]["webapps"])["runs"]) == 3 * 4
    assert len(first.blobs.get_json(aligned["local"]["formplayer"]["trace"])["runs"]) == 4
    assert at_b["served"] and len(first.blobs.get_json(at_b["formplayer"]["trace"])["runs"]) == 4

    again = observe_document(document, core_runner=core_runner, editor_driver=editor_driver)
    _same_served(first, again)
    _same_parts(first, again)


def _asked(trace) -> list:
    """What each step of a walk's trace asked HQ, by the view and its status, in order."""
    return [list(map(tuple, step.get("asked") or ())) for run in trace["runs"] for step in run["steps"]]


@pytest.mark.under_determinism
def test_what_a_run_asks_hq_does_not_depend_on_an_earlier_walk_of_the_same_state(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    with apps.published(formplayer_documents[FETCHED_AGAIN], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            first = apps.walked(formplayer_runner, served)
            # Seconds later, well inside the five minutes Formplayer keeps what a query fetched.
            again = apps.walked(formplayer_runner, served)
    asked = _asked(first)
    assert any(view == "case_fixture" for step in asked for view, _ in step), asked
    assert _asked(again) == asked
    assert again == first


def test_a_trace_names_formplayers_own_address_by_a_mark_so_every_runner_records_it_alike():
    """Formplayer writes the URL it was asked at into an error's answer, and each runner's web server listens on
    a port drawn as it starts: two lane runs kept different records for every such answer until the address was
    written as a mark. Another address in the same answer is kept as it is."""
    from types import SimpleNamespace

    from proof.formplayer import observe

    served = SimpleNamespace(hq=SimpleNamespace(restores=[]), build_id="build", usercase_id=None)

    def recorded(port, other="http://127.0.0.1:9/navigate_menu"):
        trace = {"runs": [{"steps": [{"response": {"url": f"http://127.0.0.1:{port}/navigate_menu", "other": other}}]}]}
        return observe.marked(trace, served=served, runner=SimpleNamespace(ready={"port": port}))

    assert recorded(41000) == recorded(42000)
    assert recorded(41000)["runs"][0]["steps"][0]["response"] == {
        "url": f"{observe.FORMPLAYER}/navigate_menu",
        "other": "http://127.0.0.1:9/navigate_menu",
    }


def test_a_resource_formplayer_reads_at_its_remote_location_is_answered_by_hqs_own_view(
    hq, core_runner, formplayer_runner, formplayer_documents
):
    """Where the archive's copy of a form cannot be installed, Core reads it at the remote location HQ's profile
    names under the build's own address (``JavaHttpReference``, a URL connection Formplayer's RestTemplate never
    sees). The runner sends that connection to HQ's peer, as Formplayer's replace-host mode sends its other
    requests (``PeerUrls.java``), so HQ's own download view answers it; before, it left for the address HQ's
    settings name, over the network, and one hosted run waited on it past the request's deadline."""
    with apps.published(formplayer_documents[REMOTE_RESOURCE], core_runner) as published:
        with apps.served(published, formplayer_runner) as served:
            trace = apps.walked(formplayer_runner, served)
            refused = [(asked.url_name, asked.status) for asked in served.hq.exchanges if not 200 <= asked.status < 300]
    asked = _asked(trace)
    assert any(view == "app_download_file" for step in asked for view, _ in step), asked
    assert refused == [], refused
