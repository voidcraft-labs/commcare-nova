"""Explicit pytest entry for one diagnostic B operation. Never collected by the release suite."""

from contextlib import contextmanager
import json
import os
import re
import signal
import time
from pathlib import Path

from proof.diagnostics import stages
from proof.observe.record import Blobs, canonical

READER = r"(?:formplayer|webapps|android/(?:phone|tablet))"
POSITION = r"[0-9]+\.[0-9]+"
PAGE = rf"page/(?:app_settings|view_module/[0-9]+|view_form/{POSITION})"
EDITOR = rf"(?:vellum/{POSITION}|{PAGE})"
SCOPE = re.compile(rf"(?:{READER}|{EDITOR}|vellum/{POSITION}/(?:first|second)/{READER}|{PAGE}/section/[a-z0-9-]+/{READER})")


def parse_request(raw):
    request = json.loads(raw)
    required = {"document", "configuration", "stage", "seconds"}
    if not isinstance(request, dict) or not required <= set(request) <= required | {"inputSha256", "mode"}:
        raise ValueError("A replay needs document, configuration, stage and seconds.")
    mode = request.get("mode", "reproduce")
    if mode not in ("reproduce", "fresh"):
        raise ValueError("Choose reproduce for the original inputs or fresh to exercise current inputs.")
    if not isinstance(request["stage"], str) or not SCOPE.fullmatch(request["stage"]):
        raise ValueError("Choose formplayer, webapps, android/phone, android/tablet, vellum/M.F or page/HQ_VIEW[/M[.F]].")
    key = request.get("inputSha256")
    if (mode == "reproduce" or "inputSha256" in request) and (
        not isinstance(key, str) or not re.fullmatch("[a-f0-9]{64}", key)
    ):
        raise ValueError("Use the original operation's inputSha256, or choose fresh for a new input receipt.")
    if any(not isinstance(request[k], str) or not request[k] for k in ("document", "configuration")):
        raise ValueError("The document and configuration must be present.")
    if type(request["seconds"]) is not int or not 1 <= request["seconds"] <= 1200:
        raise ValueError("Set a whole-second diagnostic deadline between 1 and 1200.")
    return request


def _write(path, data):
    temp = path.with_suffix(".tmp")
    temp.write_bytes(data)
    temp.replace(path)


class Expired(BaseException):
    """Unwind the native context without allowing an ordinary runtime refusal handler to claim a result."""


def execute(request, directory, native):
    """Keep independent evidence, including a start marker if the process is killed before it can finish."""
    directory.mkdir(parents=True, exist_ok=False)
    path = directory / "stage.json"
    start = time.perf_counter()

    details = {"phase": "preparing"}
    previous_key = request.get("inputSha256")

    def report(status, **fields):
        seconds = round(time.perf_counter() - start, 3)
        _write(path, canonical({**request, **details, **fields, "status": status, "elapsed": seconds}))

    def arrived(key):
        matches = key == previous_key if previous_key is not None else None
        details.update(observedInputSha256=key, inputMatchesReference=matches)
        mismatch = matches is False and request.get("mode", "reproduce") == "reproduce"
        details["phase"] = "input-mismatch" if mismatch else "native"
        report("running")

    def expire(_signum, _frame):
        raise Expired(f"{request['stage']} exceeded its {request['seconds']} second deadline")

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()

    report("started")
    outer, repeat = signal.getitimer(signal.ITIMER_REAL)
    install_timer = not outer or request["seconds"] < outer
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    if install_timer:
        previous_alarm = signal.signal(signal.SIGALRM, expire)
        signal.setitimer(signal.ITIMER_REAL, request["seconds"])
    try:
        required_key = previous_key if request.get("mode", "reproduce") == "reproduce" else None
        with stages.expecting(request["stage"], required_key, arrived):
            output, blobs = native()
        data = canonical(output)
        attachments = blobs.named_by(output)
        (directory / "blobs").mkdir()
        for ref in attachments.refs():
            _write(directory / "blobs" / ref.split(":")[1], attachments.get(ref))
        _write(directory / "native.json", data)
        report("observed", outputSha256=stages.digest(data), blobs=len(attachments.refs()))
        return output
    except Expired:
        report("timed-out")
        raise
    except KeyboardInterrupt:
        report("interrupted")
        raise
    except BaseException as exc:
        report("failed", error=type(exc).__name__)
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        if install_timer:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_alarm)
            if outer:
                signal.setitimer(signal.ITIMER_REAL, max(0.001, outer - (time.perf_counter() - start)), repeat)


def _selected(ctx, scope):
    from proof.observe import proof4

    observation = proof4._Observation(ctx, proof4.hq_order)
    if scope.startswith(("page/", "vellum/")):
        parent = re.match(EDITOR, scope).group()
        kind, target = parent.split("/", 1)

        def view(name, position):
            loc = ".".join(str(n) for n in position if n is not None)
            return kind == "page" and target == "/".join(filter(None, (name, loc)))

        try:
            with stages.baseline(ctx):
                record = observation.observe(
                    views=view, forms=lambda position: kind == "vellum" and target == ".".join(map(str, position))
                )
        except stages.Captured as done:
            return done.result
        rows = record["views" if kind == "page" else "vellum"]
        if parent != scope or len(rows) != 1:
            raise ValueError(f"The selected editor did not issue {scope!r} on this release.")
        return rows[0]

    with stages.baseline(ctx), ctx.unit.fork():
        if not ctx.serve:
            raise ValueError("Choose the served-reader profile that produced this operation.")
        # Build the same starting state as proof4.prepare, including its saved previous build, opened
        # app and Core case processing. Other native reader calls and every editor save are independent.
        observation.serves = False
        observation.prepare()
        with observation._serving("proof4", ctx.previous_build) as held:
            if scope.startswith("android/"):
                from proof.observe.served import observes_state

                if not observes_state("android", held.served):
                    raise ValueError("This release does not run the Android device stage.")
                return held.android("B", device=scope.split("/")[1])
            side, trace = held.formplayer(baseline=True)
            if scope == "formplayer":
                return side
            return held.webapps(trace, baseline=True)


@contextmanager
def prepared(document, configuration, *, core_runner, editor_driver, store):
    """Reconstruct the persisted A and its real B update without observing unrelated A/B/editor/reader parts."""
    from proof.hq.state import hq_unit
    from proof.observe import connect, unit
    from proof.store import guard

    with guard.observing(document, None, guard.KEYS):
        inputs = unit.document_inputs(document)
        if inputs != unit.computed_inputs(document):
            raise ValueError("The emitted corpus input digests disagree with the files supplied for replay.")
        cases, databases = unit._case_inputs(document)
        hooks = unit.hook_inputs(document)
        keys = unit.part_keys(inputs, configuration, databases, hooks)
    with guard.observing(document, configuration, "configuration", hooks):
        export = document.exports[configuration]
        config = export.configuration.hq()
    blobs = Blobs()
    with hq_unit(config, root_key=keys["a"]) as hq, unit._connect_closed() as closing:
        state = unit._Unit(document, export, config, hq, core_runner, editor_driver, store, blobs, {}, cases, hooks)
        state.replay_b_key = keys.get("b")
        closing.append(state.connect)
        with guard.observing(document, configuration, "a", hooks):
            state.create_a(state.ops("recreate"), full=False)
        if state.app_id is None:
            raise ValueError("HQ did not create A for this operation.")
        with guard.observing(document, configuration, "b", hooks):
            captured = export.republish
            if captured is None:
                raise ValueError("The captured republish refused before there was a B.")
            ops = state.ops("b")
            if state.publish_over_a(ops, captured, "B")["refused"] is not None:
                raise ValueError("HQ refused the captured republish.")
            built, _, _ = unit._build(hq, ops, core_runner, state.app_id, "B", state.saved_a)
            if not built.outcome.files:
                raise ValueError("HQ built no release of B.")
            if not state.a_built or not state.a_built.outcome.files:
                raise ValueError("HQ built no original release of A.")
            if connect.is_connect(state.a_built.outcome.files) or connect.is_connect(built.outcome.files):
                raise ValueError("A Connect replay requires its original opportunity and forwarding history.")
            ctx = state.b_context(ops, "B", built, captured)
            yield ctx


def test_selected_stage(request):
    """Run explicitly under the pinned harness against the original emission; report outside the release store."""
    from proof.checks import cases
    from proof.store import runtime

    raw = os.environ.get("PROOF_REPLAY_STAGE")
    if raw is None or not os.environ.get("PROOF_CORPUS"):
        raise ValueError("Pass the original emitted PROOF_CORPUS and the PROOF_REPLAY_STAGE request.")
    if os.environ.get("PROOF_HQ_DETERMINISM", "on") == "0":
        raise ValueError("A focused replay must use the original seeded HQ draws.")
    args = parse_request(raw)
    out = Path(os.environ["PROOF_OUT"]) / "diagnostics" / f"stage-{time.time_ns()}"

    def native():
        request.getfixturevalue("hq")
        doc = cases.load_corpus().document(args["document"])
        # An editor can record a new transcript, even in a diagnostic. Isolate every write (and its counters)
        # while preserving the original compatible read-only snapshot and runtime fingerprints.
        isolated = dict(os.environ, PROOF_OUT=str(out / "observer"), PROOF_CHECKPOINT_PARTS="0")
        store = runtime.session_store(doc, isolated)
        if not getattr(store, "scope", None) or not store.seeded or not os.environ.get("PROOF_IMAGE_ID"):
            raise ValueError("A replay needs pinned observation and runtime fingerprints. Use the proof launcher with its store enabled.")
        with prepared(
            doc, args["configuration"], core_runner=request.getfixturevalue("core_runner"),
            editor_driver=request.getfixturevalue("editor_driver"), store=store,
        ) as ctx:
            return _selected(ctx, args["stage"]), ctx.blobs

    execute(args, out, native)
