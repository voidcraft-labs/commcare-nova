"""Nova's reader, run from the bundle the corpus carries: how a judge reads an app CommCare HQ answered for.

The corpus job builds the bundle once, where Nova's ``node_modules`` are
(``proof/reader/build.mjs``, through ``proof.native.produce``), and the corpus
carries it as ``native/reader/``: ``reader.mjs``, and beside it sharp's
runtime (``node_modules/``, and ``runtime.json`` naming each of its files by
its sha256), so the image's Node runs it with no checkout ``node_modules``;
and ``reader.json``, the bundle's digest. A lane run
whose corpus carries no products (``npm run proof``, which mounts
``node_modules``) builds it the first time a judge asks, into
``$PROOF_OUT/native/reader/``, as the native families are produced there.

``run_reader(requests)`` writes one requests file, runs
``node reader.mjs <requests> <answers>`` through ``proof.processes`` with a
120 second deadline, and answers each request's answer in request order
(``proof/reader/cli.ts`` gives both shapes). The bundle's standard output and
standard error are its log, which is kept beside the run's evidence
(``$PROOF_OUT/reader-logs/``). A bundle that exits non-zero writes no answers
file and ends its standard error with its reason, which ``ReaderBundleFailed``
names; one that runs past its deadline is stopped with every process it
started. No answer stands for a broken reading.

Standard library only, beside ``proof.processes`` and ``proof.native.produce``
(where the corpus's products are found): the judges that run it,
``proof.checks.proof6`` and ``proof.checks.parity``, are the only modules that
import it, so no other package's tests reach the bundle
(``proof/lane/test_blocks.py``).
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

from proof import processes
from proof.native import produce

DEADLINE_SECONDS = 120
BUNDLE = "reader.mjs"
DIGEST = "reader.json"
# sharp's runtime beside the bundle, and its record: each file under RUNTIME_FILES by its path under the bundle's
# directory, with its sha256 (``proof/reader/build.mjs``; ``proof/ci/products.mjs::runtimeRecord`` holds the same).
RUNTIME = "runtime.json"
RUNTIME_FILES = "node_modules"
# The environment the bundle runs in: Nova's logger writes one JSON line an entry under ``production``, so the
# bundle's reason for failing stays the last line of its standard error.
ENVIRONMENT = {"NODE_ENV": "production"}


class ReaderBundleMissing(AssertionError):
    """The corpus carries no reader bundle, or one whose bytes are not the ones its digest names."""


class ReaderBundleFailed(AssertionError):
    """The bundle ended without an answer for every request: it exited non-zero, ran past its deadline, or wrote
    answers that are not one a request."""


def missing_message(corpus) -> str:
    return (
        f"Proof 6 runs Nova's reader from the corpus (native/reader/reader.mjs), and {corpus} holds none. The"
        " corpus job builds it (node proof/reader/build.mjs); look at native/produced.json and"
        " native/logs/reader.log for why it was not written."
    )


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _digest_of(path: Path) -> str | None:
    """The file's sha256, or None where it cannot be read (a link to nothing)."""
    try:
        return file_digest(path)
    except OSError:
        return None


def held_runtime(directory: Path) -> None:
    """sharp's runtime beside the bundle, held to its record: refused by name where ``runtime.json`` is absent or
    unreadable, a file under ``node_modules/`` is not named there with its sha256, or a file it names is missing."""
    record_path = directory / RUNTIME
    try:
        record = json.loads(record_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ReaderBundleMissing(
            f"The reader bundle in {directory} has no readable {RUNTIME} beside it ({error}): the bundle loads sharp"
            f" from the {RUNTIME_FILES}/ beside it, and {RUNTIME} names each file of that runtime. The corpus job"
            " writes both in one build (node proof/reader/build.mjs)."
        ) from error
    named = record.get("files") if isinstance(record, dict) else None
    if not isinstance(named, dict):
        raise ReaderBundleMissing(
            f"{record_path} names no files, each file of sharp's runtime by its path with its sha256, as"
            " proof/reader/build.mjs writes it."
        )
    root = directory / RUNTIME_FILES
    held = sorted(
        path.relative_to(directory).as_posix() for path in root.rglob("*") if path.is_file() or path.is_symlink()
    )
    unnamed = [path for path in held if path not in named]
    changed = [path for path in held if path in named and _digest_of(directory / path) != named[path]]
    missing = sorted(set(named) - set(held))
    if unnamed or changed or missing:
        shown = [
            *(f"{path} is not named in {RUNTIME}" for path in unnamed[:5]),
            *(f"{path} is not the file {RUNTIME} names" for path in changed[:5]),
            *(f"{path} is named in {RUNTIME} and missing" for path in missing[:5]),
        ]
        raise ReaderBundleMissing(
            f"sharp's runtime beside the reader bundle in {directory} is not the one its {RUNTIME} names"
            f" ({len(unnamed)} unnamed, {len(changed)} changed, {len(missing)} missing: {'; '.join(shown)}). The"
            " corpus job writes both in one build (node proof/reader/build.mjs); something changed the runtime after"
            " it, so no judgment over it stands for the reader that keyed it."
        )


def held_bundle(directory: Path, corpus) -> Path:
    """The bundle in ``directory`` (``reader.mjs``), refused by name where it is absent, its digest
    (``reader.json``'s ``sha256``) is not the file's, or sharp's runtime beside it is not the one its record names
    (``held_runtime``)."""
    bundle = directory / BUNDLE
    if not bundle.is_file():
        raise ReaderBundleMissing(missing_message(corpus))
    try:
        recorded = json.loads((directory / DIGEST).read_text(encoding="utf-8")).get("sha256")
    except (OSError, ValueError, AttributeError) as error:
        raise ReaderBundleMissing(
            f"The reader bundle {bundle} has no readable {DIGEST} beside it ({error}), so nothing says it is the"
            " bundle the corpus job built (node proof/reader/build.mjs)."
        ) from error
    actual = file_digest(bundle)
    if recorded != actual:
        raise ReaderBundleMissing(
            f"The reader bundle {bundle} is not the one its {DIGEST} names: the file's sha256 is {actual}, and"
            f" {DIGEST} names {recorded!r}. The corpus job writes both in one build (node proof/reader/build.mjs);"
            " something changed the bundle after it, so no judgment over it stands for the reader that keyed it."
        )
    held_runtime(directory)
    return bundle


def _built_here() -> Path:
    """The bundle built for a run whose corpus carries no products, once, under ``$PROOF_OUT/native/reader/``:
    every worker of the run waits on one lock beside it and reads the first one's build."""
    out = os.environ.get("PROOF_OUT")
    if not out:
        raise ReaderBundleMissing(missing_message("this run, which names neither PROOF_CORPUS nor PROOF_OUT,"))
    directory = Path(out) / produce.CORPUS_DIRECTORY / produce.READER
    directory.parent.mkdir(parents=True, exist_ok=True)
    with open(directory.with_name(f"{produce.READER}.lock"), "wb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (directory / BUNDLE).is_file():
            log = directory.parent / "logs" / f"{produce.READER}.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            _, failure = produce.produce_reader(directory, log)
            if failure is not None:
                raise ReaderBundleMissing(
                    f"Proof 6 runs Nova's reader, and building it here failed: it {failure}. Its output is in {log}."
                )
    return held_bundle(directory, directory.parent.parent)


def bundle_path() -> Path:
    """The reader bundle this run's judges run: the corpus's (``<corpus>/native/reader/reader.mjs``), else the one
    built here (``_built_here``)."""
    products = produce.produced_directory()
    if products is None:
        return _built_here()
    return held_bundle(products / produce.READER, products.parent)


def _log_name(requests) -> str:
    first = str(requests[0].get("id", "reading")) if requests else "reading"
    return re.sub(r"[^A-Za-z0-9._@-]+", "_", first)[:120] or "reading"


def _kept_log(name: str, stdout: Path, stderr: Path):
    out = os.environ.get("PROOF_OUT")
    if not out:
        return None
    directory = Path(out) / "reader-logs"
    directory.mkdir(parents=True, exist_ok=True)
    kept = directory / f"{name}.log"
    with kept.open("wb") as handle:
        handle.write(b"--- standard output ---\n")
        handle.write(stdout.read_bytes())
        handle.write(b"--- standard error ---\n")
        handle.write(stderr.read_bytes())
    return kept


def last_line(path: Path) -> str:
    lines = [line for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    return lines[-1] if lines else ""


def run_reader(requests: list[dict], *, log_name: str | None = None) -> list[dict]:
    """The bundle's answers to ``requests``, in request order, from one Node process (``proof/reader/cli.ts``)."""
    if not requests:
        return []
    bundle = bundle_path()
    name = log_name or _log_name(requests)
    with tempfile.TemporaryDirectory(prefix="reader-") as scratch:
        scratch = Path(scratch)
        requests_path, answers_path = scratch / "requests.json", scratch / "answers.json"
        stdout, stderr = scratch / "stdout.log", scratch / "stderr.log"
        requests_path.write_text(json.dumps({"requests": requests}, ensure_ascii=False), encoding="utf-8")
        environment = {**os.environ, **ENVIRONMENT}
        try:
            with stdout.open("wb") as out, stderr.open("wb") as err:
                status = processes.run(
                    ["node", str(bundle), str(requests_path), str(answers_path)],
                    timeout=DEADLINE_SECONDS,
                    cwd=scratch,
                    env=environment,
                    stdout=out,
                    stderr=err,
                )
        except processes.TimedOut as error:
            kept = _kept_log(name, stdout, stderr)
            raise ReaderBundleFailed(
                f"Nova's reader ran past its {DEADLINE_SECONDS} s deadline reading {name} and was stopped ({error})."
                f" Its log is in {kept or stderr}."
            ) from error
        kept = _kept_log(name, stdout, stderr)
        if status != 0:
            reason = last_line(stderr) or "it gave no reason"
            raise ReaderBundleFailed(
                f"Nova's reader stopped reading {name} with exit status {status}: {reason}. Its log is in"
                f" {kept or stderr}."
            )
        try:
            answers = json.loads(answers_path.read_text(encoding="utf-8"))["answers"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ReaderBundleFailed(
                f"Nova's reader exited cleanly reading {name} and wrote no answers file the judge can read ({error})."
                f" Its log is in {kept or stderr}."
            ) from error
    asked = [request.get("id") for request in requests]
    given = [answer.get("id") if isinstance(answer, dict) else None for answer in answers]
    if given != asked:
        raise ReaderBundleFailed(
            f"Nova's reader answered {given} to the requests {asked} reading {name}: one answer a request, in"
            " request order, is what proof/reader/cli.ts writes."
        )
    return answers
