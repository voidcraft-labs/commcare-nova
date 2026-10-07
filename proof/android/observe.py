"""Android's reading of every archive a device installs of a document, from what a lane run observed.

    python3 -m proof.android.observe --store <run output>/store --corpus <corpus> --out <directory> \\
        [--document <id> ...] [--only <archive name substring>] [--search <text> ...] [--query-answer <text>]

For each archive ``proof.android.archives.document_archives`` names, the reader answers one request on a device
of its own (``proof.android.client``), ``app``: the install's status; what each of Android's profile readers
gives; and the screens Android's home activity takes a worker through from each command of the installed suite,
over the restore HQ served for the document's cases: each case list (its Sort menu, its header row and first
rows as Android lays them out, and what each ``--search`` finds), a search screen (what it sends for
``--query-answer``, then the list behind it), the form it opens (its title, its screens), or where home starts
nothing, what it tells the worker;

and, once per document, ``installs``: each pair the checks compare as two installs of one app (the two local
archives; A then B) installed on one device in turn.

The answers are written under ``--out`` as ``<document>/<archive name>.json`` (``/`` and ``:`` in a name
written ``__``), canonical JSON, with ``<document>/installs.json`` beside them, and one line per request says
what it took.

Standard library only; it needs a reader runtime (``PROOF_ANDROID_RUNTIME``) and ``java`` on the path.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from proof.android import archives
from proof.android.client import AndroidReader, AndroidReaderError


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, indent=1, ensure_ascii=False) + "\n"


def file_name(name: str) -> str:
    return name.replace("/", "__").replace(":", "__").replace(" ", "-")


def observe_archive(reader, path: Path, restore: Path | None, *, searches=(), query_answer=None, preferences=None):
    """The reader's answer for one archive on one device (the ``app`` request, which holds the profile's readers
    too), or what the reader could not answer, named in place."""
    arguments = {
        **({"restore": str(restore)} if restore is not None else {}),
        **({"searches": list(searches)} if searches else {}),
        **({"queryAnswer": query_answer} if query_answer is not None else {}),
        **({"preferences": preferences} if preferences else {}),
    }
    try:
        return reader.request("app", archive=str(path), **arguments)
    except AndroidReaderError as error:
        return {"readerFailed": str(error), "log": error.log[-4000:]}


def observe_document(reader, store: Path, root: Path, out: Path, *, only=None, **options) -> list[str]:
    document_id = root.name
    listed = archives.document_archives(store, document_id, root)
    lines = []
    with tempfile.TemporaryDirectory(prefix="proof-android-observe-") as scratch:
        scratch = Path(scratch)
        restores = {}
        materialized = {}
        for archive in listed:
            if only and only not in archive.name:
                continue
            configuration = archive.name.split("/", 1)[0] if archive.path is None else "minimum"
            if configuration not in restores:
                content = archives.restore_of(store, document_id, configuration)
                restores[configuration] = None
                if content is not None:
                    restores[configuration] = scratch / f"restore-{configuration}" / "restore.xml"
                    restores[configuration].parent.mkdir()
                    restores[configuration].write_bytes(content)
            path = archives.materialize(store, archive, scratch / "archives" / (file_name(archive.name) + ".ccz"))
            materialized[archive.name] = path
            answer = observe_archive(reader, path, restores[configuration], **options)
            target = out / document_id / (file_name(archive.name) + ".json")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(canonical(answer), encoding="utf-8")
            lines.append(f"{document_id} {archive.name}: {reader.seconds[-1]} s")
        pairs = {}
        for first, second in (("local.ccz", "local-again.ccz"), ("local.ccz", "local.ccz")):
            if first in materialized and second in materialized:
                pairs[f"{first} then {second}"] = [materialized[first], materialized[second]]
        for configuration in sorted({name.split("/")[0] for name in materialized if name.endswith("/A")}):
            if f"{configuration}/B" in materialized:
                pairs[f"{configuration}/A then {configuration}/B"] = [
                    materialized[f"{configuration}/A"],
                    materialized[f"{configuration}/B"],
                ]
        installs = {}
        for name, paths in pairs.items():
            try:
                installs[name] = reader.request("installs", archives=[str(path) for path in paths])
            except AndroidReaderError as error:
                installs[name] = {"readerFailed": str(error), "log": error.log[-4000:]}
        if installs:
            target = out / document_id / "installs.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(canonical(installs), encoding="utf-8")
    return lines


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--store", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--document", action="append")
    parser.add_argument("--only")
    parser.add_argument("--search", action="append", default=[])
    parser.add_argument("--query-answer")
    parser.add_argument("--preference", action="append", default=[], help="name=value, a worker's own setting")
    options = parser.parse_args(argv)
    documents = options.document or sorted(
        entry["group"].split(":", 1)[1]
        for entry in archives.disk.Delta(options.store).entries("documents").values()
        if entry["group"].startswith("corpus:")
    )
    preferences = dict(item.split("=", 1) for item in options.preference)
    with AndroidReader() as reader:
        for document_id in documents:
            for line in observe_document(
                reader,
                options.store,
                options.corpus / document_id,
                options.out,
                only=options.only,
                searches=options.search,
                query_answer=options.query_answer,
                preferences=preferences,
            ):
                print(line, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
