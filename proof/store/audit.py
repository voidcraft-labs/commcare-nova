"""The evidence store's audits: fresh records held to the store, and two lane runs held to each other.

    python3 -m proof.store.audit compare --store DIR --mismatches DIR OUTPUT...
    python3 -m proof.store.audit compare [--masked] --left OUTPUT... --right OUTPUT...

With ``--store``: every entry the outputs' runs made (``proof.store.pack.gather``:
record parts, documents, judgments and group outcomes) that the snapshot also
holds under the same key must be the one it holds, and no key may hold two
values within the run (two shards that observed one key differently, which
``gather`` drops). Each that differs is written under
``--mismatches/<kind>/<key>/`` (``held.json``, what the store holds, and
``fresh.json``, or ``fresh-<n>.json`` for each of a run's differing values),
and the comparison fails: a key that missed an input, or an observation that
is not a function of its inputs. An absent or empty store holds nothing to
differ. This is the nightly audit's comparison, over a lane run fresh in
every group.

With ``--left`` and ``--right`` (each one lane run: every shard output it
uploaded): the two runs' record parts are paired by what they are (the
document's group and the part's name) rather than by key, since their keys
name different images, architectures or environments; each pair must hold
the same record. Every check's evidence is paired by check and document and
must be the same, byte for byte as canonical JSON. With ``--masked``, only
the evidence is compared, the right run's held to the left's but for the
values each drew (``alike_but_for_draws``): every id-shaped token
(``MASKED``) stands where one of its kind stands, and each value the right
run drew stands for one value of the left's everywhere. Two of the right
run's may stand for one of the left's: a seeded run draws an id from its
state's key, so two states of one key hold one id where an unseeded run
draws two, and the seeded run is the left one. A part or
evidence record only one run holds is named too, and so is a key or an
evidence record one run holds two values of.

The lane's in-session audit writes its mismatches with ``write_mismatch``
(``proof.store.runtime.Store.audit``), under ``<output>/audit/``.

Exits 0 when everything compared is alike, 1 when anything differs, 2 when
the arguments cannot be read. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from proof.lane import blocks as lane_blocks
from proof.store import disk, pack

# The values a run draws afresh where its entropy and clock are not seeded: hex ids of 64, 40, 32 and 16
# digits, UUIDs, and ISO dates and times.
MASKED = re.compile(
    r"\b(?:[0-9a-f]{64}|[0-9a-f]{40}|[0-9a-f]{32}|[0-9a-f]{16})\b"
    r"|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"
    r"|\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b"
)
# The entries an audit holds to the store: a transcript is replayed only where HQ answers alike, so any is right.
AUDITED = ("parts", "documents", "judgments", "groups")


class StoreMismatch(AssertionError):
    """A part observed afresh differs from the one held under its key."""


def write_mismatch(directory: Path, key: str, held: bytes | None, fresh: bytes, *, why: str) -> StoreMismatch:
    """Write both records of a mismatch under ``directory/<key>/`` and return the error that fails the group."""
    where = Path(directory) / key
    where.mkdir(parents=True, exist_ok=True)
    (where / "fresh.json").write_bytes(fresh)
    if held is not None:
        (where / "held.json").write_bytes(held)
    return StoreMismatch(
        f"A part observed afresh differs from the record held under its key {key[:16]} ({why}); both are in"
        f" {where}. Its key names every input the guard saw it read, so look for an input it reads unseen (a"
        " clock, an unseeded draw, a file outside the guard's reach) or an observation that depends on order."
    )


def _evidence(outputs) -> tuple[dict, list[str]]:
    """Every check's evidence the runs wrote, by (check, kind, document), and each one two blocks wrote apart."""
    found, differing = {}, []
    for output in outputs:
        for directory, _ in lane_blocks.read_manifests(Path(output)):
            for path in sorted(Path(directory, "checks").glob("*/*.json")):
                record = json.loads(path.read_bytes())
                identity = (record["check"], record["kind"], record["document"])
                held = found.setdefault(identity, record)
                if disk.canonical(held) != disk.canonical(record) and identity not in differing:
                    differing.append(identity)
    return found, differing


def _parts(gathered: pack.Gathered) -> dict:
    """Each record the runs' documents were judged from, by (group, part name), as its digest."""
    found = {}
    for entry in gathered.index["documents"].values():
        for name, (_, held) in entry["parts"].items():
            found[(entry["group"], name)] = held
    return found


BLOB = "sha256:"


def _kind(token: str) -> str:
    """What a drawn token is: a UUID, a hex id of its length, or a date or time."""
    if len(token) == 36 and token.count("-") == 4:
        return "uuid"
    if "-" not in token and ":" not in token:
        return f"hex{len(token)}"
    return "time"


def alike_but_for_draws(held: str, fresh: str, read_held=None, read_fresh=None, _seen=None) -> bool:
    """Whether ``fresh`` is ``held`` (two texts: a record's canonical JSON, or a blob's) but for the values a
    run draws afresh (``MASKED``).

    Every drawn token of ``fresh`` stands where one of the same kind stands in ``held``, the text between
    them is the same, and each value ``fresh`` drew stands for one value of ``held`` everywhere it appears: an
    id written where another's belongs, or a time where an id was, is a difference. Two values of ``fresh``
    may stand for one of ``held``, since a seeded run draws an id from its state's key, so two states of one
    key hold one id where an unseeded run draws two. With ``read_held`` and ``read_fresh`` (each a blob's
    bytes by its ``sha256:`` name, or None), a pair of blob names that differ is held to the same rule over
    the blobs' contents, and to the same bytes where they are not text.
    """
    found_held, found_fresh = list(MASKED.finditer(held)), list(MASKED.finditer(fresh))
    if MASKED.sub(lambda match: f"<{_kind(match.group(0))}>", held) != MASKED.sub(
        lambda match: f"<{_kind(match.group(0))}>", fresh
    ):
        return False
    stands_for = {}
    for one, other in zip(found_held, found_fresh, strict=True):
        if stands_for.setdefault(other.group(0), one.group(0)) != one.group(0):
            return False
    if read_held is None or read_fresh is None:
        return True
    seen = set() if _seen is None else _seen
    for one, other in zip(found_held, found_fresh, strict=True):
        pair = (one.group(0), other.group(0))
        if pair[0] == pair[1] or pair in seen or not fresh.startswith(BLOB, other.start() - len(BLOB)):
            continue
        seen.add(pair)
        blob_held, blob_fresh = read_held(BLOB + pair[0]), read_fresh(BLOB + pair[1])
        if blob_held is None or blob_fresh is None:
            if blob_held is not blob_fresh:
                return False
            continue
        try:
            texts = blob_held.decode("utf-8"), blob_fresh.decode("utf-8")
        except UnicodeDecodeError:
            if blob_held != blob_fresh:
                return False
            continue
        if not alike_but_for_draws(*texts, read_held, read_fresh, seen):
            return False
    return True


def masked(value) -> str:
    """``value`` as the canonical JSON ``alike_but_for_draws`` reads."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _content(kind: str, entry, source) -> bytes:
    """What a mismatch shows of an entry: a part's record and a judgment's evidence as their blobs, else the entry."""
    if kind in ("parts", "judgments"):
        found = source.blob(entry["record"] if kind == "parts" else entry)
        if found is not None:
            return found
    return disk.canonical(entry)


def _drawn_alike(kind: str, values, gathered: pack.Gathered) -> bool:
    """Whether the values an unseeded run's shards kept under one key are one but for what each drew."""
    texts = [_content(kind, value, gathered).decode("utf-8") for value in values]
    return all(alike_but_for_draws(texts[0], text, gathered.blob, gathered.blob) for text in texts[1:])


def _conflicts(
    gathered: pack.Gathered, mismatches: Path | None, held: disk.Snapshot, *, but_for_draws: bool = False
) -> list[str]:
    """Each key the run's outputs hold two values under, written beside what the store holds there. With
    ``but_for_draws`` (an unseeded run, whose shards each drew their own ids), values that are one but for what
    each drew are not two."""
    problems = []
    for kind in AUDITED:
        for key, values in sorted(gathered.conflicted[kind].items()):
            if but_for_draws and _drawn_alike(kind, values, gathered):
                continue
            shown = "the run's outputs"
            if mismatches is not None:
                where = Path(mismatches) / kind / key
                where.mkdir(parents=True, exist_ok=True)
                for number, value in enumerate(values, 1):
                    (where / f"fresh-{number}.json").write_bytes(_content(kind, value, gathered))
                stored = held.get(kind, key)
                if stored is not None:
                    (where / "held.json").write_bytes(_content(kind, stored, held))
                shown = str(where)
            problems.append(
                f"The run's shards kept {len(values)} different {kind} entries under {key[:16]}: one key's inputs"
                f" were observed or judged differently within one run; see {shown}."
            )
    return problems


def compare_store(store: Path, outputs, mismatches: Path) -> tuple[list[str], list[str]]:
    held = disk.Snapshot(store) if Path(store).is_dir() else disk.Snapshot(None)
    gathered = pack.gather(outputs)
    problems = _conflicts(gathered, mismatches, held)
    for kind in AUDITED:
        for key, value in sorted(gathered.index[kind].items()):
            stored = held.get(kind, key)
            if stored is None or disk.canonical(stored) == disk.canonical(value):
                continue
            where = Path(mismatches) / kind / key
            where.mkdir(parents=True, exist_ok=True)
            (where / "held.json").write_bytes(_content(kind, stored, held))
            (where / "fresh.json").write_bytes(_content(kind, value, gathered))
            problems.append(f"The store holds another {kind[:-1]} under {key[:16]} than this run made; see {where}.")
    return problems, gathered.notes


def compare_runs(left, right, *, masked_only: bool) -> tuple[list[str], list[str]]:
    problems, notes = [], []
    sides = {"left": pack.gather(left), "right": pack.gather(right)}
    for side, gathered in sides.items():
        # The right run of a masked comparison is the unseeded one, whose shards each drew their own values.
        own = _conflicts(gathered, None, disk.Snapshot(None), but_for_draws=masked_only and side == "right")
        problems += [f"In the {side} run: {problem}" for problem in own]
        notes += [f"The {side} run: {note}" for note in gathered.notes]
    if not masked_only:
        left_parts, right_parts = _parts(sides["left"]), _parts(sides["right"])
        for identity in sorted(set(left_parts) | set(right_parts)):
            one, other = left_parts.get(identity), right_parts.get(identity)
            if one is None or other is None:
                side = "left" if one is not None else "right"
                problems.append(f"Only the {side} run kept the record {identity[0]} {identity[1]}.")
            elif one != other:
                problems.append(f"The runs kept different records for {identity[0]} {identity[1]}.")
    (left_evidence, left_differing), (right_evidence, right_differing) = _evidence(left), _evidence(right)
    for side, differing in (("left", left_differing), ("right", right_differing)):
        problems += [
            f"The {side} run wrote {check}'s evidence on {kind}:{document} twice, differently."
            for check, kind, document in differing
        ]
    for identity in sorted(set(left_evidence) | set(right_evidence)):
        one, other = left_evidence.get(identity), right_evidence.get(identity)
        if one is None or other is None:
            side = "left" if one is not None else "right"
            problems.append(f"Only the {side} run wrote {identity[0]}'s evidence on {identity[1]}:{identity[2]}.")
            continue
        alike = (
            alike_but_for_draws(masked(one), masked(other))
            if masked_only
            else disk.canonical(one) == disk.canonical(other)
        )
        if not alike:
            problems.append(
                f"{identity[0]}'s evidence on {identity[1]}:{identity[2]} differs between the runs"
                + (" once their drawn values are masked." if masked_only else ".")
            )
    return problems, notes


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.store.audit", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    compare = commands.add_parser("compare", help="fresh records against the store, or one run against another")
    compare.add_argument("--store", type=Path, help="the snapshot to hold the outputs to")
    compare.add_argument("--mismatches", type=Path, help="where to write each mismatch (with --store)")
    compare.add_argument("--masked", action="store_true", help="compare evidence with drawn values masked")
    compare.add_argument("--left", nargs="+", type=Path, help="one lane run's shard outputs")
    compare.add_argument("--right", nargs="+", type=Path, help="the other lane run's shard outputs")
    compare.add_argument("outputs", nargs="*", type=Path, help="the shard outputs to hold to --store")
    arguments = parser.parse_args(argv)
    paired = arguments.left is not None or arguments.right is not None
    if arguments.store is not None and not paired:
        if arguments.mismatches is None or not arguments.outputs or arguments.masked:
            print("compare --store takes --mismatches and the shard outputs to hold to it, unmasked.", file=sys.stderr)
            return 2
        problems, notes = compare_store(arguments.store, arguments.outputs, arguments.mismatches)
    elif paired and arguments.store is None and not arguments.outputs:
        if not arguments.left or not arguments.right:
            print("compare --left and --right each take one lane run's shard outputs.", file=sys.stderr)
            return 2
        problems, notes = compare_runs(arguments.left, arguments.right, masked_only=arguments.masked)
    else:
        print("compare takes either --store with outputs, or --left and --right.", file=sys.stderr)
        return 2
    for note in notes:
        print(note, file=sys.stderr)
    for problem in problems:
        print(problem)
    if not problems:
        print("Everything compared is alike.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
