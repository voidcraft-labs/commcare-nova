"""Durable copies of complete ordinary parts. A partial reader, editor fragment, or test verdict is never an atom.

The live worker seals its normal delta first. The host uploads a single bounded immutable file, and supplies
its source and queue receipt independently. A receiver can create a parts-only read-only baseline; the normal
store owns cache lookup and fresh audits, and the normal lane still has to run all the checks.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
from pathlib import Path

from proof.store import disk

MAX_BYTES = 32 << 20
MAX_HEADER = 256 << 10
MAX_BLOBS = 4096
JOB_BYTES = 256 << 20
JOB_COUNT = 128
MAX_OMISSIONS = 512
OMISSIONS = ".reader-part-omissions.json"
ROOT = Path(__file__).resolve().parents[1]
IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9-]{0,79}")
GROUP = re.compile(r"corpus:[a-z0-9][a-z0-9-]{0,79}(?:@[A-Za-z0-9_.~-]{1,96})?")
FILE = re.compile(r"\.reader-part-([0-9a-f]{64})\.bin")
HEADER_KEYS = {"version", "group", "block", "part", "stored", "profile", "record", "blobs"}


def sha(content):
    return hashlib.sha256(content).hexdigest()


def eligible(document, corpus, group):
    if document is None or not corpus:
        return False
    return (
        document.kind == "corpus"
        and IDENTIFIER.fullmatch(document.id)
        and document.source == f"hq-authored:{document.id}"
        and document.root.resolve() == (Path(corpus).resolve() / document.id)
        and GROUP.fullmatch(group)
        and group.partition("@")[0] == document.group
        and (ROOT / "hq-apps" / document.id / "application.json").is_file()
    )


class Stager:
    """Only a host-enabled, seeded synthetic corpus group may stage raw, reusable proof data."""

    @classmethod
    def for_group(cls, document, store, environ):
        group = environ.get("PROOF_GROUP", "")
        block = environ.get("PROOF_BLOCK", "")
        if (
            environ.get("PROOF_CHECKPOINT_PARTS") == "1"
            and store.seeded
            and disk.HEX.fullmatch(block)
            and eligible(document, environ.get("PROOF_CORPUS"), group)
        ):
            return cls(store.delta, group, block, store.fingerprints, store.environment)
        return None

    def __init__(self, delta, group, block, fingerprints, environment):
        self.delta = delta
        self.output = delta.root.parent
        self.owner = {
            "group": group,
            "block": block,
            "profile": sha(disk.canonical({"fingerprints": fingerprints, "environment": environment})),
        }

    def _omit(self, row):
        path = self.output / OMISSIONS
        omissions = json.loads(path.read_bytes()) if path.exists() else {"version": 1, "parts": [], "additional": 0}
        if row in omissions["parts"]:
            return
        if len(omissions["parts"]) < MAX_OMISSIONS:
            omissions["parts"].append(row)
        else:
            omissions["additional"] += 1
        disk.write_whole(path, disk.canonical(omissions), replace=True)

    def settled(self, part, stored):
        entry = self.delta.get("parts", stored)
        if entry is None:
            raise ValueError("The proposed checkpoint has no sealed ordinary part.")
        refs = [entry["record"], *entry["blobs"]]
        chunks = [[ref, disk.blob_path(self.delta.root, ref).stat().st_size] for ref in refs]
        header = {"version": 1, **self.owner, "part": part.hex(), "stored": stored, "record": refs[0], "blobs": chunks}
        meta = disk.canonical(header)
        size = 4 + len(meta) + sum(n for _, n in chunks)
        with (self.output / ".reader-part.lock").open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            reason = None
            if len(chunks) > MAX_BLOBS:
                reason = "part-blobs"
            elif len(meta) > MAX_HEADER:
                reason = "header-bytes"
            elif size > MAX_BYTES:
                reason = "part-bytes"
            else:
                # Every native write sealed these named bytes before the entry, and the named bytes must still agree.
                wire = bytearray(len(meta).to_bytes(4, "big") + meta)
                for ref, length in chunks:
                    with disk.blob_path(self.delta.root, ref).open("rb") as source:
                        data = source.read(length + 1)
                    if len(data) != length or disk.digest_of(data) != ref:
                        raise ValueError("The sealed part has a missing or damaged blob.")
                    wire.extend(data)
                path = self.output / f".reader-part-{sha(wire)}.bin"
                if path.exists():
                    return
                previous = [p.stat().st_size for p in self.output.glob(".reader-part-*.bin") if FILE.fullmatch(p.name)]
                if len(previous) >= JOB_COUNT:
                    reason = "job-count"
                elif sum(previous) + size > JOB_BYTES:
                    reason = "job-bytes"
                else:
                    disk.write_whole(path, wire, replace=False)
                    return
            self._omit(
                {
                    **self.owner,
                    "part": part.hex(),
                    "stored": stored,
                    "record": refs[0],
                    "bytes": size,
                    "blobCount": len(chunks),
                    "reason": reason,
                }
            )


def read_member(directory, name, limit):
    """Open a single regular artifact member under a pinned directory descriptor and bound the bytes read."""
    import stat

    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as member:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= limit:
            raise ValueError("Invalid checkpoint artifact member.")
        data = member.read(info.st_size + 1)
        if len(data) != info.st_size:
            raise ValueError("Checkpoint artifact member changed while being read.")
        return data


def decoded(data):
    if len(data) < 4 or len(data) > MAX_BYTES:
        raise ValueError("Invalid checkpoint size.")
    size = int.from_bytes(data[:4], "big")
    if not 0 < size <= MAX_HEADER or 4 + size > len(data):
        raise ValueError("Invalid checkpoint header size.")
    meta = data[4 : 4 + size]
    header = json.loads(meta)
    if (
        not isinstance(header, dict)
        or set(header) != HEADER_KEYS
        or type(header["version"]) is not int
        or header["version"] != 1
        or not isinstance(header["group"], str)
        or not GROUP.fullmatch(header["group"])
        or not all(
            isinstance(header[k], str) and disk.HEX.fullmatch(header[k]) for k in ("part", "stored", "profile", "block")
        )
        or meta != disk.canonical(header)
    ):
        raise ValueError("Invalid checkpoint header.")
    records = header["blobs"]
    if not isinstance(records, list) or not 0 < len(records) <= MAX_BLOBS:
        raise ValueError("Invalid checkpoint blob count.")
    offset = 4 + size
    chunks = {}
    for row in records:
        if not isinstance(row, list) or len(row) != 2:
            raise ValueError("Invalid checkpoint blob entry.")
        ref, length = row
        if type(length) is not int or length < 0 or length > len(data) - offset:
            raise ValueError("Invalid checkpoint blob length.")
        chunk = memoryview(data)[offset : offset + length]
        if ref != disk.digest_of(chunk) or ref in chunks:
            raise ValueError("A checkpoint blob is repeated or differs from the digest of its contents.")
        chunks[ref] = chunk
        offset += length
    names = list(chunks)
    if offset != len(data) or names[0] != header["record"] or names[1:] != sorted(names[1:]):
        raise ValueError("Checkpoint bytes differ from its complete ordered entry.")
    record = bytes(chunks[names[0]])
    parsed = json.loads(record)
    if (
        not isinstance(parsed, dict)
        or parsed.get("kind") not in ("a", "b", "b_aligned", "local")
        or disk.canonical(parsed) != record
    ):
        raise ValueError("Expected a canonical ordinary part record.")
    return header, chunks


def current_parts(document, group):
    """Derive ordinary keys from this corpus, its actual file bytes, the case database and the native hooks."""
    from proof.observe import unit
    from proof.store import guard

    selected = group.partition("@")[2].partition("~")[0]
    with guard.observing(document, None, guard.KEYS):
        if selected and selected not in document.exports:
            raise ValueError("The queued configuration is absent from the current app.")
        inputs = unit.document_inputs(document)
        if inputs != unit.computed_inputs(document):
            raise ValueError("The emitted document's named inputs differ from its actual files.")
        hooks = unit.hook_inputs(document)
        databases = unit.case_databases(document)
        found = {unit.local_key(inputs, hooks).hex(): "local"}
        for name in document.exports:
            if selected and selected != name:
                continue
            for kind, key in unit.part_keys(inputs, name, databases, hooks).items():
                found[key.hex()] = "b" if kind == "b_edit" else kind
        return found


def verified(identity, data, expected, queue, environ, corpus_root):
    """Verify an independently downloaded run receipt against the replay's source, queue, store and emitted inputs."""
    from proof.checks import corpus
    from proof.store import fingerprints, keys

    if identity.get("kind") != "reader-part" or identity.get("version") != 1:
        raise ValueError("Expected a version 1 reader-part receipt.")
    source = identity["source"]
    if any(source.get(key) != value for key, value in expected.items()):
        raise ValueError("The checkpoint came from another run, attempt, commit, image or fingerprint set.")
    row = identity["part"]
    file_sha = sha(data)
    if row["sha256"] != file_sha or row["bytes"] != len(data):
        raise ValueError("The complete part artifact differs from the receipt.")
    if row["artifact"] != f"proof-part-{source['shard']}-{source['attempt']}-{file_sha}.bin":
        raise ValueError("The part's artifact name differs from its source.")
    if row["phase"] not in ("early", "main") or identity["queues"].get(row["phase"]) != sha(queue):
        raise ValueError("The checkpoint identifies another queue.")
    matching = [b for b in json.loads(queue)["blocks"] if b["id"] == row["block"]]
    if len(matching) != 1 or not any(g["group"] == row["group"] for g in matching[0]["groups"]):
        raise ValueError("The checkpoint's group is not in its queued block.")
    header, chunks = decoded(data)
    if any(header[k] != row[k] for k in ("group", "block", "part", "stored", "profile", "record")):
        raise ValueError("The sealed part and its published receipt disagree.")
    found = fingerprints.current(environ)
    environment = keys.environment(environ)
    if not found or environment["PROOF_HQ_DETERMINISM"] != "on":
        raise ValueError("Reusable checkpoints require a seeded, fingerprinted proof environment.")
    if header["profile"] != sha(disk.canonical({"fingerprints": found, "environment": environment})):
        raise ValueError("The checkpoint's fingerprints or reader environment differ from this replay.")
    scope = keys.record_scope(found, environ)
    if keys.storage_key(scope, bytes.fromhex(header["part"])) != header["stored"]:
        raise ValueError("The ordinary store's scoped key differs from the checkpoint's key.")
    group = row["group"]
    document = corpus.load(corpus_root).document(group.partition("@")[0].removeprefix("corpus:"))
    if not eligible(document, corpus_root, group):
        raise ValueError("This checkpoint is not from a retained synthetic HQ corpus document.")
    kind = current_parts(document, group).get(header["part"])
    if kind is None or json.loads(bytes(chunks[header["record"]])).get("kind") != kind:
        raise ValueError(
            "Changed document or reader inputs: this checkpoint is not an ordinary part of the current app."
        )
    return header, chunks


def restore(directories, output, *, queue, corpus_root, run, attempt, commit, image, environ):
    """Publish a new snapshot at once after every expected artifact and current part key verifies."""
    import tempfile

    from proof.store import fingerprints

    scoped = environ.get(fingerprints.ENVIRONMENT, "")
    if not scoped or not all((run, attempt, commit, image)):
        raise ValueError("Missing expected source or proof fingerprints.")
    expected = {
        "run": run,
        "attempt": attempt,
        "commit": commit,
        "image": image,
        "fingerprints": sha(f"PROOF_FINGERPRINTS={scoped}".encode()),
    }
    if output.exists() or not directories:
        raise ValueError("Choose an absent destination and supply at least one completed part.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".reader-restore-", dir=output.parent) as scratch:
        staging = Path(scratch) / "snapshot"
        staging.mkdir()
        index = disk.empty_index()
        for directory in directories:
            opened = os.open(directory, os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                identity = json.loads(read_member(opened, "identity.json", MAX_HEADER))
                row = identity["part"]
                name = row["artifact"]
                if not isinstance(name, str) or not re.fullmatch(
                    r"proof-part-[A-Za-z0-9_-]{1,80}-[0-9]+-[a-f0-9]{64}\.bin", name
                ):
                    raise ValueError("Invalid checkpoint artifact name.")
                data = read_member(opened, name, MAX_BYTES)
            finally:
                os.close(opened)
            header, chunks = verified(identity, data, expected, queue, environ, corpus_root)
            names = list(chunks)
            entry = {"record": names[0], "blobs": names[1:]}
            stored = header["stored"]
            previous = index["parts"].setdefault(stored, entry)
            if previous != entry:
                raise disk.EntryConflict("parts", stored, previous, entry)
            for content in chunks.values():
                disk.write_blob(staging, content)
        disk.write_whole(
            staging / disk.INDEX, disk.canonical({"version": disk.VERSION, **index}) + b"\n", replace=False
        )
        staging.rename(output)
    return len(index["parts"])


def main():
    import argparse
    import sys

    if sys.argv[1:] == ["inspect"]:
        # The unprivileged host decoder never prints native payloads or arbitrary producer-provided messages.
        try:
            header, _ = decoded(sys.stdin.buffer.read(MAX_BYTES + 1))
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
            print("Invalid completed proof part.", file=sys.stderr)
            return 1
        print(json.dumps({key: header[key] for key in ("block", "group", "part", "stored", "profile", "record")}))
        return 0

    parser = argparse.ArgumentParser(
        description="Restore complete proof parts from a known hosted run into a new snapshot."
    )
    parser.add_argument("--from-run", required=True, help="trusted producer run id")
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--commit", required=True, help="expected checkout SHA of the producer and replay")
    parser.add_argument("--image-id", required=True, help="actual reader image ID of the producer and replay")
    parser.add_argument("--queue", type=Path, required=True, help="original independently obtained queue file")
    parser.add_argument("--corpus", type=Path, required=True, help="freshly emitted corpus root")
    parser.add_argument("--out", type=Path, required=True, help="new isolated snapshot directory")
    parser.add_argument(
        "artifacts", type=Path, nargs="+", help="one extracted, independently obtained part artifact per directory"
    )
    args = parser.parse_args()
    count = restore(
        args.artifacts,
        args.out,
        queue=args.queue.read_bytes(),
        corpus_root=args.corpus,
        run=args.from_run,
        attempt=args.attempt,
        commit=args.commit,
        image=args.image_id,
        environ=os.environ,
    )
    print(f"Recovered {count} complete ordinary parts; all group judgments remain to run.")


if __name__ == "__main__":
    raise SystemExit(main())
