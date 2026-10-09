"""One test session's native proofs: each producer, HQ step and Core run happens once.

``NativeSession`` owns ``$PROOF_OUT/native``. It empties it when the session
starts, so nothing an earlier session wrote can stand in for this one's
artifacts, and then fills it on demand:

- ``family(name)`` gives the family's producer's output (``families.FAMILIES``)
  the first time any test needs it: copied from the products the lane's
  corpus carries (``$PROOF_CORPUS/native``, which CI's ``quality`` job writes
  with ``python3 -m proof.native.produce``, since a CI shard mounts no
  ``node_modules``), or, when it carries none, produced here from the
  checkout's root with the Linux ``node_modules`` the lane mounts
  (``produce.produce_family``); ``prefetch(names)`` does several at once.
- ``step(name)`` runs the family's HQ step (``steps.STEPS``) once, on HQ's
  shared boot (``proof.hq.boot``), after its producer, and fails every later
  call the same way if it failed.
- ``core_run(name, selection)`` runs Core's Gradle test build once for a
  selection of proof classes; ``core()`` is the whole suite, run after every
  family is produced and every HQ step has run (a failed step does not stop
  the run: its classes then report what they could not read).

Each result is kept for the session, and ``timings`` records what each cost.
Every process a producer, the Connect fetch or a Core build starts, its own
children included (the esbuild service ``tsx`` starts, Vitest's workers,
git's helpers, Core's test JVM), is stopped and reaped before the call that
started it returns, however it ended (``proof.processes``).
"""

import os
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from proof.connect import checkout as connect_checkout
from proof.connect.checkout import Checkout, CheckoutFailed
from proof.hq.boot import GUARD, HarnessRefusal, boot
from proof.native import core_suite, produce
from proof.native.families import CORE_CLASSES, FAMILIES, MEDIA_CERTIFICATE

WORKTREE = Path(__file__).resolve().parents[2]


class ProducerFailed(RuntimeError):
    """A family's producer did not write its corpus."""


class StepFailed(RuntimeError):
    """A family's HQ step failed; every test that needs it reports the same failure."""


class CoreArtifactMissing(AssertionError):
    """A Core class did not write the artifact an HQ check reads after it."""


def native_output_dir():
    out = os.environ.get("PROOF_OUT")
    if not out:
        raise RuntimeError(
            "The native proofs write their artifacts under $PROOF_OUT/native, and PROOF_OUT is not set. "
            "Run them through the proof harness (npm run proof -- proof/native), which sets it to /out."
        )
    return Path(out) / "native"


class NativeSession:
    def __init__(self, out: Path, core_runner):
        self.out = out
        self._core_runner = core_runner
        shutil.rmtree(out, ignore_errors=True)
        (out / "logs").mkdir(parents=True)
        self._produced: dict[str, BaseException | None] = {}
        self._producer_lock = threading.Lock()
        self._vitest_lock = threading.Lock()
        self._steps: dict[str, tuple[bool, object]] = {}
        self._core_runs: dict[str, object] = {}
        self._connect: Checkout | BaseException | None = None
        self._scratch = Path(tempfile.mkdtemp(prefix="proof-native-"))
        self.timings: dict[str, float] = {}

    def close(self):
        """Remove what the session fetched outside ``$PROOF_OUT`` (the Connect checkout)."""
        shutil.rmtree(self._scratch, ignore_errors=True)

    # Producers ----------------------------------------------------------

    def family(self, name: str) -> Path:
        """The family's corpus directory, produced first if this session has not yet produced it."""
        self.prefetch([name])
        failure = self._produced[name]
        if failure is not None:
            raise ProducerFailed(str(failure)) from failure
        return self.out / name

    def prefetch(self, names):
        """Produce every named family this session has not yet produced, several at a time."""
        missing = [name for name in dict.fromkeys(names) if name not in self._produced]
        unknown = [name for name in missing if name not in FAMILIES]
        if unknown:
            raise KeyError(f"The native proofs have no family named {unknown}; families.FAMILIES lists them.")
        if not missing:
            return
        with self._producer_lock, ThreadPoolExecutor(max_workers=produce.PRODUCER_CONCURRENCY) as pool:
            for name, failure in zip(missing, pool.map(self._produce, missing), strict=True):
                self._produced[name] = failure

    def _produce(self, name):
        directory = self.out / name
        log = self.out / "logs" / f"{name}.producer.log"
        products = produce.produced_directory()
        started = time.perf_counter()
        try:
            if products is not None:
                failure = produce.read_product(products, name, directory, log)
            else:
                _, failure = produce.produce_family(FAMILIES[name], directory, log, vitest_lock=self._vitest_lock)
        finally:
            self.timings[f"{'read' if products is not None else 'producer'}:{name}"] = round(
                time.perf_counter() - started, 3
            )
        if failure is None:
            return None
        tail = log.read_text(errors="replace")[-4000:] if log.is_file() else ""
        return ProducerFailed(
            f"The {name} producer {failure}. Its output ({log}) ends:\n{tail}"
            if tail
            else f"The {name} producer {failure}."
        )

    # Upstreams fetched at run time -----------------------------------------

    def connect_checkout(self) -> Checkout:
        """commcare-connect at its pin (proof/pins.json), fetched once for the session.

        Connect's source is never in the harness image (its checkout carries
        no license file), so the Connect proof fetches exactly the pinned
        commit into the session's scratch directory
        (``proof.connect.checkout.fetch``).
        """
        if self._connect is None:
            started = time.perf_counter()
            try:
                self._connect = self._fetch_connect()
            except CheckoutFailed as failure:
                self._connect = failure
            finally:
                self.timings["fetch:commcare-connect"] = round(time.perf_counter() - started, 3)
        if isinstance(self._connect, BaseException):
            raise self._connect
        return self._connect

    def _fetch_connect(self) -> Checkout:
        return connect_checkout.fetch(
            self._scratch / "commcare-connect", self.out / "logs" / "commcare-connect.fetch.log"
        )

    # HQ steps -------------------------------------------------------------

    def validate_form(self, xml: bytes) -> str:
        """Formplayer's own answer to HQ's form validation of these bytes (``proof.hq.seams.formplayer_validation``,
        the session's validation Formplayer)."""
        from proof.hq.seams import formplayer_validation

        return formplayer_validation(xml)

    def step(self, name: str):
        """The result of the named HQ step, run once per session after its family's producer."""
        from proof.native.steps import STEPS

        if name not in self._steps:
            step = STEPS[name]
            started = time.perf_counter()
            watched = len(GUARD.attempts)
            try:
                boot()
                result = step.run(self)
                refused = [attempt for attempt in GUARD.attempts[watched:] if not attempt.allowed]
                if refused:
                    raise StepFailed(
                        f"HQ reached for the network during the {name} step, which the harness refused:\n"
                        + "\n".join(
                            f"  {a.kind} {a.address} from {' <- '.join(reversed(a.where[-4:]))}" for a in refused
                        )
                    )
                self._steps[name] = (True, result)
            except (Exception, HarnessRefusal) as failure:
                self._steps[name] = (False, failure)
            finally:
                self.timings[f"step:{name}"] = round(time.perf_counter() - started, 3)
        succeeded, value = self._steps[name]
        if not succeeded:
            raise StepFailed(f"The {name} HQ step failed: {type(value).__name__}: {value}") from value
        return value

    def step_failure(self, name: str):
        """The named step's failure, if it ran and failed."""
        succeeded, value = self._steps.get(name, (True, None))
        return None if succeeded else value

    # Core -----------------------------------------------------------------

    def core_run(self, name: str, selection: str):
        """Core's Gradle test build over ``selection``, run once per session under ``name``."""
        if name not in self._core_runs:
            work = self.out / "core" / name
            shutil.rmtree(work, ignore_errors=True)
            try:
                self._core_runs[name] = core_suite.run_core_tests(selection, native_dir=self.out, work_dir=work)
            except core_suite.CoreBuildFailed as failure:
                self._core_runs[name] = failure
            if not isinstance(self._core_runs[name], BaseException):
                self.timings[f"core:{name}"] = round(self._core_runs[name].seconds, 3)
        run = self._core_runs[name]
        if isinstance(run, BaseException):
            raise run
        return run

    def core(self):
        """Every proof class, run once after every family's producer and HQ step."""
        if "suite" not in self._core_runs:
            from proof.native.steps import STEPS

            self.prefetch(sorted(set(CORE_CLASSES.values())))
            for name in STEPS:
                try:
                    self.step(name)
                except (StepFailed, ProducerFailed):
                    pass  # recorded; the classes that read the step's family report it
        return self.core_run("suite", "*")

    def media_certificate(self):
        """Core's parse of the media sources HQ's media pass sends to Formplayer, as a certificate file."""
        run = self.core_run("media-certificate", MEDIA_CERTIFICATE)
        cls, method = MEDIA_CERTIFICATE.split(".")
        tests = run.classes.get(cls)
        passed = tests is not None and [t.outcome for t in tests.tests if t.name == method] == ["passed"]
        if not passed:
            problems = [] if tests is None else [f"{t.name}: {t.message}" for t in tests.problems()]
            raise StepFailed(
                f"Core did not certify the media sources ({MEDIA_CERTIFICATE}), so HQ's media pass cannot "
                f"check that Core parsed exactly the forms it validates. Core reported: {problems or 'no result'}. "
                f"Gradle's output is in {run.log}."
            )
        return self.out / "media" / "core-validated-sources.properties"

    def core_artifact(self, family: str, filename: str, junit_class: str) -> Path:
        """A file a Core class writes for an HQ check, after the suite ran."""
        run = self.core()
        path = self.out / family / filename
        if not path.is_file():
            result = run.classes.get(junit_class)
            report = (
                "Gradle reported no results for it"
                if result is None
                else "; ".join(f"{t.name} {t.outcome}: {t.message}" for t in result.problems()) or "every test passed"
            )
            raise CoreArtifactMissing(
                f"{junit_class} did not write {path}, which this HQ check reads. Core's report for the class: {report}."
            )
        return path

    def upstream_failures(self, family: str):
        """What failed before Core read ``family``: its producer, and its HQ step."""
        from proof.native.steps import STEPS

        failures = []
        produced = self._produced.get(family)
        if produced is not None:
            failures.append(f"producer: {produced}")
        for name, step in STEPS.items():
            if step.family == family and (failure := self.step_failure(name)) is not None:
                failures.append(f"HQ step {name}: {type(failure).__name__}: {failure}")
        return failures
