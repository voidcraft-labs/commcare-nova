"""``python3 -m proof.android.stage``: the lane's Android stage, CommCare Android's own code as a judged reader.

    python3 -m proof.android.stage run --queue FILE --corpus DIR --out DIR [--bin i/n] [--store DIR]
        [--jobs N] [--records] OUTPUT...
    python3 -m proof.android.stage show --out DIR

The lane's shards run where commcare-android's code cannot (Robolectric's native runtime ships for Linux on
x86-64 and for macOS alone, ``proof/android/README.md``), so Android reads after them, from what they observed.
``run`` takes the Android queue (``python3 -m proof.store.queue android``: each document's Android group, a
block or cached), the shards' outputs (``OUTPUT``, whose deltas hold the documents' records) and the evidence
store's snapshot (``--store``, for a document the lane read from the store and for Android records kept
before), and runs the blocks of its bin (``--bin``, the static bins every shard of the stage computes alike,
``proof.checks.sharding.static_bins``). For each group:

1. the document's records give its archives and restores, and ``proof.android.records.plan`` the requests;
2. each request's answer is read from the store under its key (``Request.key``: the archives, the restore,
   the options and the reader) or, where none holds it, made by the reader on a device of its own
   (``proof.android.client``), ``--jobs`` at a time, and kept in the run's delta under that key: an archive
   read before is never read again, in this run or a later one;
3. the judges (``proof.checks.android``: proofs 1, 3 and 4) read the answers as one document record
   (``document_record``), and each check's differences are written as the stage's evidence
   (``checks/<check>/<kind>-<id>.json``, ``"stage": "android"``) and held to the register's entries of this
   stage (an ``android@...`` artifact), as ``proof.checks.cases.hold`` holds the shards' own. A control is
   judged by the checks whose Android entries name it.

What it writes is an output like a shard's (``proof.lane.blocks``): ``blocks/<id>/block.json`` with each
group's items and outcomes (``android::<group>::records``, which fails where the reader itself could not
answer a request or a fresh answer is not the stored one, and one item a check), the evidence, the delta
(``store/``) and ``serve.json``. The lane's gate holds it with the shards' outputs: every block of the Android
queue ran exactly once, every item passed, and the evidence, beside the shards' own, holds to the register
(``python3 -m proof.lane.gate ... --android-queue FILE``). ``--records`` also writes each document's record
(``blocks/<id>/android/<kind>-<id>.json``), for a person reading what Android showed. ``show`` prints a
finished output: each group's requests read and made, and each check's differences by class.

It exits 0 when every block of its bin ran (whatever its items' outcomes, which are the gate's), 1 when a
group could not run, and 2 when its arguments cannot be read.

Standard library only; ``run`` needs a reader runtime (``PROOF_ANDROID_RUNTIME``) and ``java`` on the path.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

from proof.android import records
from proof.checks import android as judges
from proof.checks import registers, sharding
from proof.checks.differences import sorted_differences, summary
from proof.lane import blocks as lane_blocks
from proof.store import disk, keys

PROOF_DIR = Path(__file__).resolve().parents[1]
CONTROLS = PROOF_DIR / "controls"
PHASE = "android"
STAGE = registers.ANDROID
CHECKS = tuple(sorted(judges.JUDGES))
AUDIT = "audit"


class StageError(Exception):
    """Arguments, a queue or stores the stage cannot run from."""


def item(group: str, name: str) -> str:
    return f"android::{group}::{name}"


def items(group: str, checks) -> list[str]:
    return [item(group, "records"), *(item(group, check) for check in checks)]


def control_checks(entries, control: str) -> tuple[str, ...]:
    """The checks whose Android entries name the control: the ones the stage judges it by. A check only the
    shards' entries name it for is the shards' to show there, and the stage has no entry to hold it to."""
    named = registers.of_stage(entries, STAGE)
    return tuple(sorted({entry.check for entry in named if entry.control == control and entry.check in CHECKS}))


def group_checks(entries, group: str) -> tuple[str, ...]:
    kind, _, identifier = lane_blocks.android_document(group).partition(":")
    return CHECKS if kind == "corpus" else control_checks(entries, identifier)


def collection(queue_value: dict, entries) -> dict[str, str]:
    """Every item of every group the queue runs, with its group: what each shard of the stage collects."""
    found = {}
    for block in queue_value["blocks"]:
        for queued in block["groups"]:
            for name in items(queued["group"], group_checks(entries, queued["group"])):
                found[name] = queued["group"]
    return found


# One document's record ----------------------------------------------------------------------------------------


def document_record(parts: dict, answers: dict) -> dict:
    """The answers as the judges read them (``proof.checks.android``): ``answers`` by request name, None for a
    request the reader could not answer."""

    def held(target, key, name):
        if name in answers and answers[name] is not None:
            target[key] = answers[name]

    record = {"local": {}, "configurations": {}}
    held(record["local"], "app", f"app@{records.LOCAL}")
    held(record["local"], "installs", f"installs@{records.LOCAL}")
    held(record["local"], "update", f"update@{records.LOCAL}")
    for configuration in sorted({name.split("/", 1)[0] for name in parts if "/" in name}):
        found = {"saves": {}}
        record["configurations"][configuration] = found
        for part, state in records.STATES:
            name = f"{configuration}/{state}"
            if f"app@{name}" in answers and answers[f"app@{name}"] is not None:
                found[state] = {"app": answers[f"app@{name}"]}
            if state == "A":
                held(found, "installs", f"installs@{name}")
                held(found, "update", f"update@{name}")
                continue
            proof4 = (parts.get(f"{configuration}/{part}") or {}).get("proof4") or {}
            saved = []
            for label, editor, over, archive in records.saves(proof4):
                if archive is None:
                    continue
                entry = {"label": label, "editor": editor, "over": over}
                held(entry, "app", f"app@{name}/{label}")
                held(entry, "update", f"update@{name}/{label}")
                saved.append(entry)
            if saved:
                found["saves"][state] = saved
    return record


# Holding the evidence -----------------------------------------------------------------------------------------


def hold(check: str, kind: str, identifier: str, differences, entries) -> str | None:
    """Why one check's Android differences on one document or control do not hold to the register's entries of
    this stage, or None where they do (``proof.checks.cases.hold``, for this stage)."""
    entries = registers.of_stage(entries, STAGE)
    if kind == "control":
        owners = [entry for entry in entries if entry.control == identifier and entry.check == check]
        unseen = [
            entry
            for entry in owners
            if not any(entry.matches(replace(d, document=entry.document)) for d in differences)
        ]
        if not owners or unseen:
            named = [f"{e.id}: {e.check} {e.artifact} {e.path}" for e in unseen or owners]
            return (
                f"The control {identifier} no longer shows the symptom its register entries name ({named});"
                f" the Android stage's {check} must keep seeing each on the retained pre-fix inputs."
            )
        return None
    result = registers.reconcile(check, identifier, differences, entries)
    return None if result.holds else result.explain()


def write_evidence(directory: Path, check: str, kind: str, identifier: str, differences) -> None:
    record = {"check": check, "document": identifier, "kind": kind, "stage": STAGE}
    record["differences"] = [difference.as_json() for difference in sorted_differences(differences)]
    path = directory / "checks" / check / f"{kind}-{identifier}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")


# The run ------------------------------------------------------------------------------------------------------


class _Answering:
    """One request key's answer while the stage makes it: set once by the thread making it (``owner``)."""

    def __init__(self, owner: str):
        self.owner = owner
        self.done = threading.Event()
        self.answer = None
        self.failure: str | None = None


class Run:
    """One run of the stage: the queue's blocks of one bin, read and judged, written as a shard's output is."""

    def __init__(self, *, queue_path, out, corpus, outputs, store, jobs, bin_, write_records, reader=None):
        self.out = Path(out)
        if self.out.exists() and any(self.out.iterdir()):
            raise StageError(f"{self.out} already holds files; the stage writes into a new or empty directory.")
        self.queue_value = json.loads(Path(queue_path).read_text(encoding="utf-8"))
        self.queue = lane_blocks.load_queue(queue_path)
        self.corpus = Path(corpus)
        self.source = records.Source(outputs, store)
        self.snapshot = self.source.snapshot or disk.Snapshot(None)
        self.delta = disk.Delta(self.out / disk.DELTA)
        self.jobs = jobs
        self.write_records = write_records
        self.entries = registers.load_known_defects()
        self.platform = records.host_platform()
        self.fingerprint = records.fingerprint(self.platform)
        queued = (self.queue_value.get("fingerprints") or {}).get("android")
        if queued != self.fingerprint:
            raise StageError(
                f"The Android queue was built for the reader {str(queued)[:16]}, and the reader here is"
                f" {self.fingerprint[:16]} (on {self.platform}): the queue's keys name another reader's answers."
                " Build the queue from this checkout for this platform"
                f" (python3 -m proof.store.queue android --android-platform {self.platform})."
            )
        self.by_group = {queued["group"]: queued for block in self.queue_value["blocks"] for queued in block["groups"]}
        if bin_ is None:
            self.blocks = list(self.queue.blocks)
            self.shard = "1/1"
        else:
            index, count = sharding.parse_shard(bin_, "--bin")
            self.blocks = sharding.static_bins(self.queue.blocks, count)[index - 1]
            self.shard = f"{index}/{count}"
        self.reader = reader
        self.lock = threading.Lock()
        # Each request key this run is answering or has answered: the answer, made once whatever number of
        # requests share the key (``_answer``).
        self.answering: dict[str, _Answering] = {}
        self.counts = {"requests": 0, "read": 0, "made": 0, "failed": 0}
        self.problems: list[str] = []

    # Answers

    def _held(self, key: str, *, fresh: bool):
        """The record kept under ``key``: this run's own, or (unless ``fresh``) the snapshot's; None for none."""
        held = self.delta.get("android", key)
        if held is not None:
            content = self.delta.blob(held)
            if content is not None:
                return json.loads(content)
        if not fresh:
            held = self.snapshot.get("android", key)
            content = None if held is None else self.snapshot.blob(held)
            if content is not None:
                return json.loads(content)
        return None

    def _answer(self, request, scratch: Path, *, fresh: bool, failures: list):
        """One request's answer and the seconds the reader took making it.

        Requests of one document can share a key (the same archives, restore and options under two names, such
        as one save's build under two configurations), and they run on ``jobs`` threads at once. The key is
        answered once: the first thread to ask makes the answer in a scratch directory of the key's own, and
        every other request with the key waits for it. Two threads making one key's answer would each write the
        key's archive into that one directory, and the second write rewrites the file while the first device
        is unzipping it: InstallArchiveActivity's UnzipTask then reads a truncated archive, unzips nothing, and
        leaves the activity open with no result, so the reader waits out its deadline."""
        key = request.key(self.source, self.fingerprint)
        with self.lock:
            self.counts["requests"] += 1
            record = self._held(key, fresh=fresh)
            if record is None:
                answering = self.answering.get(key)
                if answering is None:
                    answering = self.answering[key] = _Answering(owner=request.name)
                    owner = True
                else:
                    owner = False
        if record is not None:
            with self.lock:
                self.counts["read"] += 1
            return record["answer"], 0.0
        if not owner:
            answering.done.wait()
            with self.lock:
                self.counts["read"] += 1
                if answering.failure is not None:
                    failures.append(
                        f"{request.name}: the reader could not answer {answering.owner}, which this"
                        f" request shares a key with: {answering.failure}"
                    )
            return answering.answer, 0.0
        try:
            return self._make(request, key, scratch, fresh=fresh, failures=failures, answering=answering)
        finally:
            answering.done.set()

    def _make(self, request, key: str, scratch: Path, *, fresh: bool, failures: list, answering):
        started = time.perf_counter()
        record = records.run(self.reader, request, self.source, scratch / key[:24])
        seconds = round(time.perf_counter() - started, 3)
        if "answer" not in record:
            with self.lock:
                self.counts["failed"] += 1
                answering.failure = record["readerFailed"]
                failures.append(f"{request.name}: {record['readerFailed']}\n{record.get('log', '')[-3000:]}")
            return None, seconds
        answering.answer = record["answer"]
        content = disk.canonical(record)
        with self.lock:
            self.counts["made"] += 1
            digest = self.delta.put_blob(content)
            try:
                self.delta.put("android", key, digest)
            except disk.EntryConflict as conflict:
                failures.append(f"{request.name}: two answers of one request differ in this run. {conflict}")
            stored = self.snapshot.get("android", key) if fresh else None
            if stored is not None and stored != digest:
                # The audit: an answer made again is the answer the store holds, byte for byte.
                directory = self.out / AUDIT / key[:24]
                directory.mkdir(parents=True, exist_ok=True)
                (directory / "fresh.json").write_bytes(content)
                (directory / "stored.json").write_bytes(self.snapshot.blob(stored) or b"")
                failures.append(
                    f"{request.name}: the reader's answer made again is not the one the store holds under"
                    f" {key[:16]}; both are under {directory}."
                )
        return record["answer"], seconds

    # Groups

    def _group(self, queued, directory: Path) -> dict:
        group = queued.group
        named = lane_blocks.android_document(group)
        kind, _, identifier = named.partition(":")
        checks = group_checks(self.entries, group)
        collected = items(group, checks)
        outcomes, failure = {}, None
        started = time.perf_counter()
        failures: list[str] = []
        timings = {}
        try:
            root = (self.corpus if kind == "corpus" else CONTROLS) / identifier
            parts = self.source.parts(named, self.by_group[group].get("document"))
            requests = records.plan(parts, root if root.is_dir() else None, self.source)
            with tempfile.TemporaryDirectory(prefix="proof-android-stage-") as scratch:
                with ThreadPoolExecutor(max_workers=self.jobs) as pool:
                    results = list(
                        pool.map(
                            lambda request: self._answer(request, Path(scratch), fresh=queued.fresh, failures=failures),
                            requests,
                        )
                    )
            answers = {request.name: answer for request, (answer, _) in zip(requests, results, strict=True)}
            timings = {request.name: seconds for request, (_, seconds) in zip(requests, results, strict=True)}
            outcomes[item(group, "records")] = "failed" if failures else "passed"
            record = document_record(parts, answers)
            if self.write_records:
                path = directory / "android" / f"{kind}-{identifier}.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(record, indent=1, sort_keys=True, ensure_ascii=False), encoding="utf-8")
            for check in checks:
                differences = judges.JUDGES[check](identifier, record)
                write_evidence(directory, check, kind, identifier, differences)
                problem = hold(check, kind, identifier, differences, self.entries)
                outcomes[item(group, check)] = "passed" if problem is None else "failed"
                if problem is not None:
                    failures.append(f"{check}: {problem}")
        except Exception as error:  # the group could not run; the next still does, and the gate names this one
            import traceback

            failure = f"{type(error).__name__}: {error}"
            failures.append(traceback.format_exc())
        if failures:
            path = directory / "android" / f"{kind}-{identifier}.failures.txt"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n\n".join(failures) + "\n", encoding="utf-8")
            self.problems += [f"{group}: {text.splitlines()[0]}" for text in failures]
        if failure is not None:
            self.problems.append(f"{group}: {failure}")
        found = lane_blocks.group_record(
            group=group,
            fresh=queued.fresh,
            collected=collected,
            outcomes=outcomes,
            worker="android",
            seconds=round(time.perf_counter() - started, 3),
            failure=failure,
        )
        found["requests"] = timings
        return found

    def run(self) -> int:
        from proof.android.client import AndroidReader

        self.out.mkdir(parents=True, exist_ok=True)
        self.delta.record_fingerprints(
            {
                "fingerprints": {
                    name: value for name, value in self.queue_value["fingerprints"].items() if name != "android"
                },
                "environment": keys.environment(keys.LANE_ENVIRONMENT),
            }
        )
        started = time.perf_counter()
        collected = collection(self.queue_value, self.entries)
        could_not_run = False

        def run_blocks():
            nonlocal could_not_run
            for block in self.blocks:
                directory = lane_blocks.block_dir(self.out, block.id)
                directory.mkdir(parents=True, exist_ok=True)
                groups = []
                for queued in block.groups:
                    found = self._group(queued, directory)
                    groups.append(found)
                    could_not_run = could_not_run or found["failure"] is not None
                    passed = sum(outcome == "passed" for outcome in found["outcomes"].values())
                    print(
                        f"[android] {queued.group}: {passed} of {len(found['collected'])} items passed in"
                        f" {found['seconds']} s ({len(found['requests'])} requests).",
                        flush=True,
                    )
                lane_blocks.write_json(
                    directory / lane_blocks.MANIFEST,
                    lane_blocks.manifest(block, phase=PHASE, shard=self.shard, groups=groups),
                )

        if self.reader is not None:
            run_blocks()
        else:
            with AndroidReader() as reader:
                self.reader = reader
                run_blocks()
        lane_blocks.write_json(
            self.out / lane_blocks.SERVE,
            {
                "selection": {
                    "pytest": [],
                    "addopts": "",
                    "environment": {name: keys.LANE_ENVIRONMENT.get(name) for name in keys.SELECTION_ENVIRONMENT},
                },
                "phases": [
                    {
                        "phase": PHASE,
                        "collected": {
                            "digest": lane_blocks.collection_digest(collected),
                            "items": len(collected),
                        },
                    }
                ],
                "android": {
                    "reader": self.fingerprint,
                    "platform": self.platform,
                    "shard": self.shard,
                    "blocks": len(self.blocks),
                    "seconds": round(time.perf_counter() - started, 3),
                    **self.counts,
                },
                "problems": self.problems,
            },
        )
        print(
            f"[android] {len(self.blocks)} blocks in {time.perf_counter() - started:.1f} s:"
            f" {self.counts['requests']} requests, {self.counts['read']} read from the store,"
            f" {self.counts['made']} made by the reader, {self.counts['failed']} the reader could not answer.",
            flush=True,
        )
        for problem in self.problems[:40]:
            print(f"[android] {problem}", flush=True)
        return 1 if could_not_run else 0


def show(out: Path) -> int:
    """A finished output, for a person: each group's items, and each check's differences by class."""
    out = Path(out)
    serve = json.loads((out / lane_blocks.SERVE).read_text(encoding="utf-8"))
    print(json.dumps(serve["android"], sort_keys=True))
    for directory, manifest in lane_blocks.read_manifests(out):
        for group in manifest["groups"]:
            failed = sorted(name for name, outcome in group["outcomes"].items() if outcome != "passed")
            print(f"{group['group']}: {len(group['requests'])} requests, {group['seconds']} s, failed: {failed}")
        for path in sorted(Path(directory, "checks").glob("*/*.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            from proof.checks.differences import Difference

            differences = [Difference(**difference) for difference in record["differences"]]
            print(f"  {record['check']} on {record['kind']}:{record['document']}: ", end="")
            print(summary(differences) if differences else "no differences")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.android.stage", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run the Android queue's blocks of one bin")
    run.add_argument("--queue", required=True, type=Path, help="the Android queue")
    run.add_argument("--corpus", required=True, type=Path, help="the emitted corpus the lane ran")
    run.add_argument("--out", required=True, type=Path, help="where the stage writes its output")
    run.add_argument("--bin", help="i/n: the static bin of the queue's blocks this shard runs")
    run.add_argument("--store", type=Path, help="the evidence store's snapshot")
    run.add_argument("--jobs", type=int, default=2, help="how many devices read at once")
    run.add_argument("--records", action="store_true", help="also write each document's record")
    run.add_argument("outputs", nargs="*", type=Path, help="every shard's output directory")
    shown = commands.add_parser("show", help="print a finished output")
    shown.add_argument("--out", required=True, type=Path)
    arguments = parser.parse_args(argv)
    if arguments.command == "show":
        return show(arguments.out)
    try:
        stage = Run(
            queue_path=arguments.queue,
            out=arguments.out,
            corpus=arguments.corpus,
            outputs=arguments.outputs,
            store=arguments.store,
            jobs=max(1, arguments.jobs),
            bin_=arguments.bin,
            write_records=arguments.records,
        )
    except (
        StageError,
        lane_blocks.QueueError,
        sharding.ShardError,
        registers.RegisterError,
        disk.StoreFormatError,
        OSError,
    ) as error:
        print(error, file=sys.stderr)
        return 2
    return stage.run()


if __name__ == "__main__":
    sys.exit(main())
