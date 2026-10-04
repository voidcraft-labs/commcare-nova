"""Write HQ's self-check apps under a corpus's ``hq/`` directory.

    python -m proof.corpus.hq --out <corpus>/hq

For each app, ``<out>/<id>/`` holds ``app.json`` (an HQ app as HQ's import
receives it) or ``app.ccz`` (an HQ-built archive), and ``configuration.json``:
CommCare 2.54.0, the version the research built these apps at, every plan
privilege HQ defines (``corehq/privileges.py::MAX_PRIVILEGES``, as the
research granted), and every flag and project setting off.
``<out>/index.json`` lists them (``{apps: [{id, source, group, file}],
leftOut: [{path, reason}], timings}``).

It boots HQ (``proof.hq.boot``) to run the tests it harvests
(``proof.corpus.hq.harvest``); it reaches no network and no database.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

from proof.corpus.hq import harvest, sources

SELF_CHECK_COMMCARE_VERSION = "2.54.0"


def all_privileges():
    """Every plan privilege HQ defines, by its constant in ``corehq/privileges.py``."""
    from corehq import privileges

    constants = {}
    for name, value in vars(privileges).items():
        if name.isupper() and isinstance(value, str):
            constants.setdefault(value, name)
    missing = [slug for slug in privileges.MAX_PRIVILEGES if slug not in constants]
    if missing:
        raise RuntimeError(f"corehq/privileges.py names no constant for the privileges {missing}.")
    return sorted(constants[slug] for slug in privileges.MAX_PRIVILEGES)


def configuration(privileges):
    return {
        "flags": [],
        "privileges": privileges,
        "commcareVersion": SELF_CHECK_COMMCARE_VERSION,
        "commtrack": False,
        "syncCasesOnFormEntry": False,
        "caseSearchEnabled": False,
    }


def _json(value):
    return json.dumps(value, indent="\t", sort_keys=True) + "\n"


def write_app(out: Path, app_id: str, file: str, content: bytes, privileges) -> None:
    directory = out / app_id
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True)
    (directory / file).write_bytes(content)
    (directory / "configuration.json").write_text(_json(configuration(privileges)))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m proof.corpus.hq")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    timings = {}
    apps = []

    started = time.perf_counter()
    from proof.hq.boot import boot

    boot()
    privileges = all_privileges()
    timings["boot"] = round(time.perf_counter() - started, 3)

    started = time.perf_counter()
    tests, left_out = sources.hq_test_apps()
    archives, archives_left_out = sources.ccz_apps()
    left_out += archives_left_out
    for app in [*tests, *sources.template_apps(), *archives]:
        write_app(out, app.id, app.file, app.path.read_bytes(), privileges)
        apps.append({"id": app.id, "source": app.source, "group": f"hq/{app.id}", "file": app.file})
    timings["files"] = round(time.perf_counter() - started, 3)

    started = time.perf_counter()
    for test in harvest.TESTS:
        harvested = harvest.run_test(test)
        harvest.with_sources(harvested)
        content = json.dumps(harvest.source_json(harvested.app), sort_keys=True).encode("utf-8")
        write_app(out, test.id, "app.json", content, privileges)
        apps.append(
            {
                "id": test.id,
                "source": {
                    "kind": "harvest",
                    "test": test.node_id,
                    "captured": harvested.captured_from,
                    "expected": test.expected,
                },
                "group": f"hq/{test.id}",
                "file": "app.json",
            }
        )
    timings["harvest"] = round(time.perf_counter() - started, 3)

    ids = [app["id"] for app in apps]
    if len(set(ids)) != len(ids):
        raise RuntimeError(f"Two HQ self-check apps share an id: {sorted(i for i in ids if ids.count(i) > 1)}.")
    (out / "index.json").write_text(
        _json(
            {
                "apps": apps,
                "leftOut": [{"path": str(item.path), "reason": item.reason} for item in left_out],
                "timings": timings,
            }
        )
    )
    print(f"Wrote {len(apps)} HQ self-check apps to {out}; left out {len(left_out)}.", file=sys.stderr)


if __name__ == "__main__":
    main()
