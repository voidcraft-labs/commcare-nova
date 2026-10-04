"""What the native proofs read from Nova's TypeScript, produced where Nova's ``node_modules`` are.

    python3 -m proof.native.produce --out DIR [--jobs N]

runs every native family's producer (``families.FAMILIES``) and the publish
capture's two commands once, from the checkout's root, and writes into DIR,
which must be new or empty:

- ``<family>/``: what the family's producer wrote, which
  ``NativeSession.family`` copies into ``$PROOF_OUT/native/<family>``, where
  the family's HQ step adds HQ's artifacts beside it;
- ``publish-capture/``: ``documents.json`` (``proof/hq/publishCaptureDocuments.ts``),
  ``out/`` (``proof/corpus/writePublishCaptures.ts``) and ``summary.txt``
  (the capture writer's report), which ``proof/hq/test_publish_capture.py``
  applies to HQ;
- ``produced.json``: each product's outcome, ``{"<name>": {"status": <its
  command's exit status, or null when it did not run to an end>, "error":
  <why it failed, or null>}}``;
- ``logs/<name>.log``, each product's output, and ``timings.json``, each
  product's seconds: how the run went. The products and ``produced.json`` are
  what the proofs read.

A product that fails is recorded and the others still run, so one producer's
failure fails only the tests that read its family: the command exits 0 once
it has run every product, and 2 when it could not write DIR.

Standard library only: CI's ``quality`` job runs it on the runner's own Python
beside the corpus emission, and the corpus carries DIR as ``native/``
(``produced_directory``), so the lane's shards, which mount no
``node_modules``, read the products instead of producing them. A lane run
whose corpus carries no ``native/`` (``npm run proof``, which mounts
``node_modules``) produces each family the first time a test needs it,
through the same ``produce_family``.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from proof import processes
from proof.native.families import FAMILIES

WORKTREE = Path(__file__).resolve().parents[2]
PRODUCER_TIMEOUT_SECONDS = 300
# Producers compile Nova's TypeScript on start, so a few at a time use the
# cores without starving each other.
PRODUCER_CONCURRENCY = 4
# The products' directory in the lane's corpus.
CORPUS_DIRECTORY = "native"
PRODUCED = "produced.json"
PUBLISH_CAPTURE = "publish-capture"
# The publish capture's two commands, run as their command lines run them.
NODE = ("node", "--conditions=react-server", "--import", "tsx")
CAPTURE_DOCUMENTS = "proof/hq/publishCaptureDocuments.ts"
CAPTURE_WRITER = "proof/corpus/writePublishCaptures.ts"


def produced_directory() -> Path | None:
    """The products the lane's corpus carries (``$PROOF_CORPUS/native``), or None when it carries none."""
    corpus = os.environ.get("PROOF_CORPUS")
    if not corpus:
        return None
    directory = Path(corpus) / CORPUS_DIRECTORY
    return directory if directory.is_dir() else None


def _without_install() -> str:
    """Why a command of Nova's cannot run here, when this checkout has no ``node_modules``; else empty."""
    if (WORKTREE / "node_modules").is_dir():
        return ""
    return (
        "; this checkout has no node_modules (a CI shard mounts none) and the lane's corpus carries no "
        f"{CORPUS_DIRECTORY}/, which CI's quality job writes beside the corpus "
        f"(`python3 -m proof.native.produce --out <corpus>/{CORPUS_DIRECTORY}`)"
    )


def _run(command, *, shown, log: Path, env=None, stdout=None, timeout=PRODUCER_TIMEOUT_SECONDS):
    """Run ``command`` from the checkout's root, its output appended to ``log``.

    Returns (exit status, None), or (None, why it did not end).

    ``stdout``, when given, takes the command's standard output instead of
    ``log``. ``shown`` is the command as a failure names it, without this
    run's own paths, so the reason reads the same wherever it ran.
    """
    with log.open("ab") as output:
        try:
            status = processes.run(
                list(command),
                timeout=timeout,
                cwd=WORKTREE,
                env=env,
                stdout=stdout if stdout is not None else output,
                stderr=output if stdout is not None else subprocess.STDOUT,
            )
        except processes.TimedOut:
            return None, (
                f"ran for more than {timeout} s and was stopped, with every process it started (`{shlex.join(shown)}`)"
            )
        except OSError as error:
            return None, f"could not start `{shlex.join(shown)}` ({error.strerror}){_without_install()}"
    return status, None


def produce_family(family, directory: Path, log: Path, *, vitest_lock=None, timeout=PRODUCER_TIMEOUT_SECONDS):
    """Run ``family``'s producer into ``directory``, its output in ``log``: (exit status, why it failed or None).

    A Vitest writer runs under ``vitest_lock``: Vitest's writers share its
    module cache in ``node_modules``, so one runs at a time.
    """
    directory.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    command = list(family.command)
    if family.output_variable:
        environment[family.output_variable] = str(directory)
    else:
        command.append(str(directory))
    lock = vitest_lock if family.uses_vitest and vitest_lock is not None else threading.Lock()
    with lock:
        status, failure = _run(command, shown=family.command, log=log, env=environment, timeout=timeout)
    if failure is None and status != 0:
        failure = (
            f"exited with status {status}, so its corpus is incomplete; it ran `{shlex.join(family.command)}` "
            f"from the checkout{_without_install()}"
        )
    if failure is None and not any(directory.iterdir()):
        failure = "exited cleanly but wrote nothing"
    return status, failure


def produce_publish_captures(directory: Path, log: Path, *, timeout=PRODUCER_TIMEOUT_SECONDS):
    """Write the publish capture into ``directory``, its output in ``log``: (exit status, why it failed or None)."""
    directory.mkdir(parents=True, exist_ok=True)
    documents = directory / "documents.json"
    status, failure = _run(
        [*NODE, CAPTURE_DOCUMENTS, str(documents)], shown=[*NODE, CAPTURE_DOCUMENTS], log=log, timeout=timeout
    )
    if failure is None and status != 0:
        failure = f"exited with status {status} writing its documents (`{CAPTURE_DOCUMENTS}`){_without_install()}"
    if failure is not None:
        return status, failure
    with (directory / "summary.txt").open("wb") as summary:
        status, failure = _run(
            [*NODE, CAPTURE_WRITER, "--documents", str(documents), "--out", str(directory / "out")],
            shown=[*NODE, CAPTURE_WRITER],
            log=log,
            stdout=summary,
            timeout=timeout,
        )
    if failure is None and status != 0:
        failure = f"exited with status {status} writing the captures (`{CAPTURE_WRITER}`){_without_install()}"
    return status, failure


def produce_all(
    out: Path, *, families=None, captures=True, jobs=PRODUCER_CONCURRENCY, timeout=PRODUCER_TIMEOUT_SECONDS
):
    """Every product into ``out`` (new or empty), ``jobs`` at a time; writes ``produced.json`` and ``timings.json``.

    ``families`` defaults to ``families.FAMILIES``; ``captures`` adds the
    publish capture. Returns what ``produced.json`` holds.
    """
    families = FAMILIES if families is None else families
    out = Path(out)
    if out.exists() and any(out.iterdir()):
        held = ", ".join(sorted(path.name for path in out.iterdir())[:3])
        raise FileExistsError(
            f"{out} already holds {held}, and the products are written only into a new or empty directory, "
            "so nothing an earlier run left there stands in for them"
        )
    logs = out / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    vitest_lock = threading.Lock()
    outcomes: dict[str, dict] = {}
    timings: dict[str, float] = {}

    def one(name):
        started = time.perf_counter()
        log = logs / f"{name}.log"
        if name == PUBLISH_CAPTURE:
            status, failure = produce_publish_captures(out / name, log, timeout=timeout)
        else:
            status, failure = produce_family(families[name], out / name, log, vitest_lock=vitest_lock, timeout=timeout)
        timings[name] = round(time.perf_counter() - started, 3)
        outcomes[name] = {"status": status, "error": failure}

    names = sorted(families) + ([PUBLISH_CAPTURE] if captures else [])
    with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        list(pool.map(one, names))
    produced = {name: outcomes[name] for name in sorted(outcomes)}
    (out / PRODUCED).write_text(json.dumps(produced, indent="\t", sort_keys=True) + "\n")
    (out / "timings.json").write_text(json.dumps(timings, indent="\t", sort_keys=True) + "\n")
    return produced


def read_product(products: Path, name: str, destination: Path, log: Path):
    """Copy the product ``name`` from ``products`` into ``destination``, and its output to ``log``.

    Returns why it failed, or None.
    """
    try:
        outcomes = json.loads((products / PRODUCED).read_text())
    except (OSError, ValueError) as error:
        return f"has no record in the corpus's products ({products}), whose {PRODUCED} could not be read ({error})"
    output = products / "logs" / f"{name}.log"
    if output.is_file():
        log.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(output, log)
    outcome = outcomes.get(name)
    if outcome is None:
        return (
            f"has no record in the corpus's products ({products}), and `python3 -m proof.native.produce` records "
            "every family and the publish capture, so they were produced from another checkout"
        )
    if outcome.get("error"):
        return f"{outcome['error']} (where the corpus was produced)"
    shutil.copytree(products / name, destination, dirs_exist_ok=True)
    return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="python3 -m proof.native.produce",
        description="Produce what the native proofs read from Nova's TypeScript (proof/native/produce.py).",
    )
    parser.add_argument("--out", required=True, type=Path, help="a new or empty directory to write into")
    parser.add_argument("--jobs", type=int, default=PRODUCER_CONCURRENCY, help="products produced at once")
    args = parser.parse_args(argv)
    started = time.perf_counter()
    try:
        produced = produce_all(args.out.resolve(), jobs=args.jobs)
    except OSError as error:
        print(f"The native products could not be written: {error}.", file=sys.stderr)
        return 2
    failed = sorted(name for name, outcome in produced.items() if outcome["error"])
    print(
        f"Produced {len(produced) - len(failed)} of {len(produced)} native products into {args.out} "
        f"in {time.perf_counter() - started:.1f} s."
    )
    for name in failed:
        print(f"  {name} {produced[name]['error']}; its output is in {args.out / 'logs' / f'{name}.log'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
