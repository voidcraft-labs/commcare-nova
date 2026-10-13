"""``python3 -m proof.lane.report``: the issue a failed night or week opens, naming each group and how to rerun it.

    python3 -m proof.lane.report --kind nightly|weekly --run URL --commit SHA --lane LABEL=VERDICT.json... [--out FILE]

Standard library only: it runs on the runner's own Python, with no image, over
the verdicts the lanes' gates wrote (``proof.lane.gate --summary``).

The nightly and the weekly are the only runs of some of what the lane proves
(every served reader, every group a pull request's store held), so a failure
there is fixed by someone who was not watching the run. The issue is written
for that person: for each lane, each group a problem names (``failing`` in the
verdict), why, and the exact command that reruns that group alone at the
commit the run checked:

- a group that failed in a lane without the readers reruns on any machine
  with Docker: ``PROOF_READERS=0 npm run proof -- <selection>``;
- a group that failed only where a reader ran needs a proof machine
  (``proof/README.md``, "Running the lane on another machine"):
  ``proof/remote/run.sh <host> -- <selection>``.

The selection is the group's own items, by their node ids: every item of a
document's or a control's group (they share one observation, and the register
is held over all of them), and the failing items of a package's group. A
group that never ran left no items to name, so it is selected by its path and
``-k``, and its line says that may select more than the group.

A document heavy enough is observed in pieces (``proof.lane.blocks``): each
configuration by a group of its own, and the document's own group after them.
A failed piece is named as that, with the line that observes that one
configuration again, alone (its one item, ``proof.checks.sharding
.piece_item``, which a run with no queue collects by the path the line
names); the document's group, which was not run because its piece failed,
reruns as any document's does, observing the document whole on one worker. Each lane's
section opens with the gate's sections that failed and their first problems,
so a problem that names no one group is still read. A lane that uploaded no
verdict is named as that. Past ``MOST_GROUPS`` groups a lane's list stops and
says how many more the verdict names, since an issue's body is bounded.

The weekly's comparison lanes check a sample of the corpus that turns each
week (``proof.store.queue.sampled``), so the issue names the seed that chose
it (``--sample-seed``, and each sampled lane's verdict) and the sample's
documents, and how to run the week again on the same sample.

A whole fresh lane also holds the committed sensitivity effects to what its
own flips showed (``python3 -m proof.checks.sensitivity held``, which writes
``effects.json`` beside the lane's verdict). Where they differ the lane's
section names each effect the file holds that no flip showed and each a flip
showed that the file lacks, and gives the lines that write the effects again
from that run's artifacts.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path

from proof.checks import sharding
from proof.lane import blocks as lane_blocks
from proof.lane import gate
from proof.lane import readers as lane_readers

# The most groups one lane lists with their commands, and the most failing items a package group reruns by name.
MOST_GROUPS = 40
MOST_ITEMS = 12
# How much of one reason is quoted, and how many of a section's problems.
REASON_CHARACTERS = 400
SECTION_PROBLEMS = 3
# The most differences between the committed effects and a run's that one lane lists.
MOST_EFFECTS = 80

# A run a person dispatched over documents they named, to see the lane run on them (proof-audit.yml's mechanics).
MECHANICS = "mechanics"
OPENINGS = {
    MECHANICS: (
        "A dispatch ran the proof lane over main at `{commit}` on documents named by hand, to show the lane's"
        " mechanics on them: the shards and their pieces, the artifacts, the gate and this report. It is no verdict"
        " on the corpus; the nightly and the weekly are."
    ),
    "nightly": (
        "The nightly ran the proof lane over main at `{commit}`, with every reader and without them, observing every"
        " group main's store did not hold, and it did not hold: a lane failed, or main's store could not be saved."
        " The lane with every reader is the only one that runs Formplayer, the Web Apps client, CommCare Android and"
        " Connect, so a failure there is one no pull request's lane showed."
    ),
    "weekly": (
        "The weekly fresh audit recomputed the proof lane whole over main at `{commit}`, with every reader and"
        " without them, beside its sampled comparisons, and it did not hold: a fresh lane failed, a stored record"
        " differs from the fresh one (a key that missed an input; the lane's \"Compare the fresh records with main's"
        ' store" step uploads both), a comparison failed (the "Weekly comparisons" job says which), the committed'
        " sensitivity effects are not what the whole fresh run's flips showed, or main's store could not be saved."
    ),
}


def selection(entry: Mapping, proof_dir: Path = sharding.PROOF_DIR) -> tuple[list[str], bool]:
    """The pytest arguments that select one failing group, and whether they select it alone (the module's
    docstring)."""
    group, items, failed = entry["group"], entry.get("items") or [], entry.get("failed") or []
    kind, _, identifier = group.partition(":")
    if kind in ("corpus", "control") and identifier:
        if items:
            return [f"proof/{node}" for node in items], True
        piece = sharding.piece_item(group)
        if piece is not None:
            # A piece is one item, named by its group alone: its configuration observed again, with no queue.
            return [f"proof/{piece}"], True
        return ["proof/checks", "-k", identifier if kind == "corpus" else f"control-{identifier}"], False
    if failed and len(failed) <= MOST_ITEMS:
        return [f"proof/{node}" for node in failed], True
    if failed:
        # Too many to name: the modules that hold them.
        return sorted({f"proof/{node.partition('::')[0]}" for node in failed}), False
    if items:
        return sorted({f"proof/{node.partition('::')[0]}" for node in items}), False
    if group == "surface":
        return ["proof/surface"], True
    if group == "proof":
        return sorted(f"proof/{path.name}" for path in Path(proof_dir).glob("test_*.py")), True
    return [group], "/" in group[len("proof/") :]


def command(entry: Mapping, readers: frozenset) -> tuple[list[str], bool]:
    """The lines that rerun one group as its lane ran it and hold the slice to the gate, and whether the first
    selects the group alone."""
    arguments, alone = selection(entry)
    chosen = " ".join(shlex.quote(argument) for argument in arguments)
    if not readers:
        return [f"PROOF_READERS=0 npm run proof -- {chosen}", "python3 -m proof.lane.gate .proof/out"], alone
    environment = "" if readers == lane_readers.EVERY else f"--env PROOF_READERS={lane_readers.canonical(readers)} "
    return [
        f"proof/remote/run.sh <host> {environment}-- {chosen}",
        "python3 -m proof.lane.gate .proof/remote/<the directory run.sh names>",
    ], alone


def _count(number: int, noun: str) -> str:
    return f"{number} {noun}{'' if number == 1 else 's'}"


def _reason(text: str) -> str:
    first = " ".join(text.split())
    return first if len(first) <= REASON_CHARACTERS else first[:REASON_CHARACTERS] + " [cut]"


def _effects(label: str, effects: Mapping | None, run: str) -> list[str]:
    """What a whole fresh lane found of the committed sensitivity effects, where it held them to its run."""
    if effects is None:
        return []
    if effects.get("holds"):
        return ["The committed sensitivity effects are what this run's flips showed.", ""]
    problems = effects.get("problems") or []
    lines = [
        "The committed sensitivity effects (`lib/commcare/surface/entries/gates.json`) are not what this run's"
        f" flips showed, over every document observed afresh: {_count(len(effects.get('stale') or []), 'effect')}"
        f" the file names that no flip showed, {_count(len(effects.get('lacking') or []), 'effect')} a flip showed"
        " that the file lacks.",
        "",
        *(f"- {_reason(problem)}" for problem in problems[:MOST_EFFECTS]),
    ]
    if len(problems) > MOST_EFFECTS:
        artifact = f"proof-lane-verdict-{label}-<attempt>"
        lines.append(f"- And {len(problems) - MOST_EFFECTS} more: `verdict/effects.json` in `{artifact}` names each.")
    identifier = run.rstrip("/").rpartition("/")[2] or "<run id>"
    lines += [
        "",
        "To write them again from this run's own evidence, at the commit above, and review what changes:",
        "",
        "```bash",
        f"gh run download {identifier} --pattern 'proof-out-{label}-*' --dir proof-outputs",
        "node --conditions=react-server --import ./proof/corpus/entropy.mts --import tsx proof/corpus/emit.ts"
        " --out proof-corpus",
        "python3 -m proof.checks.sensitivity effects proof-outputs/proof-out-*/blocks/* --corpus proof-corpus",
        "```",
        "",
    ]
    return lines


def _lane(label: str, verdict: Mapping | None, elsewhere: set[str], run: str = "") -> list[str]:
    """One lane's section: what its gate said, its failing groups with their commands, and what it found of the
    committed sensitivity effects where it held them."""
    if verdict is None:
        return [
            f"### Lane `{label}`",
            "",
            "It uploaded no verdict: its corpus was not emitted, or its gate never ran. Its jobs in the run say"
            " which step failed; nothing below names its groups.",
            "",
        ]
    readers = lane_readers.from_record(verdict.get("sections", {}).get("register", {}).get("readers"))
    title = f"### Lane `{label}` (with {lane_readers.described(readers)})"
    sample = verdict.get("sample")
    sampled = []
    if sample:
        seed = f"seed `{sample['seed']}`" if sample.get("seed") else "no seed, the ranking's first"
        documents = ", ".join(sample["documents"])
        sampled = [f"It checked a sample of {len(sample['documents'])} documents ({seed}): {documents}.", ""]
    selection = verdict.get("selection")
    if selection:
        sampled += [
            f"It checked the documents named by hand ({', '.join(selection['documents'])}) and their controls, and"
            f" left {_count(len(selection.get('left') or []), 'other group')} out: it shows the lane on those"
            " documents, and is no verdict on the corpus.",
            "",
        ]
    effects = _effects(label, verdict.get("effects"), run)
    if verdict.get("holds"):
        return [title, "", *sampled, "Its verdict held.", "", *effects]
    lines = [title, "", *sampled]
    for key, section in verdict.get("sections", {}).items():
        problems = [problem for problem in section.get("problems", []) if not problem.startswith("  ")]
        if not problems:
            continue
        lines.append(f"- Fails: {gate.TITLES.get(key, key)} ({_count(len(problems), 'problem')}). The first:")
        lines += [f"  - {_reason(problem)}" for problem in problems[:SECTION_PROBLEMS]]
    failing = verdict.get("failing") or []
    lines.append("")
    if not failing:
        lines += ["No problem names one group, so there is no slice to rerun: the problems above say what to fix.", ""]
        return [*lines, *effects]
    if readers:
        lines += [
            f"{_count(len(failing), 'group')} failed where a reader ran, so each reruns on a proof machine"
            ' (`proof/README.md`, "Running the lane on another machine"):',
            "",
        ]
    else:
        count = _count(len(failing), "group")
        lines += [f"{count} failed without the readers, so each reruns on any machine with Docker:", ""]
    for entry in failing[:MOST_GROUPS]:
        reasons = "; ".join(_reason(why) for why in entry.get("why", [])[:3])
        more = len(entry.get("why", [])) - 3
        lines.append(f"- `{entry['group']}`: {reasons}{f' (and {more} more)' if more > 0 else ''}")
        piece = lane_blocks.piece_of(entry["group"])
        if piece is not None:
            lines.append(
                f"  It is a piece: `{piece[0]}` observed under `{piece[1]}` alone, for `{piece[0]}` to judge, which"
                " was not run without it. The line below observes that configuration again."
            )
        if readers and entry["group"] in elsewhere:
            lines.append("  It fails without the readers too, so rerun it there first (that lane's list).")
        commands, alone = command(entry, readers)
        if not alone:
            lines.append("  Its items could not be named one by one, so this selects by path and may run more.")
        lines += ["", "  ```bash", *(f"  {line}" for line in commands), "  ```", ""]
    if len(failing) > MOST_GROUPS:
        lines += [
            f"And {len(failing) - MOST_GROUPS} more groups: the lane's verdict artifact"
            f" (`proof-lane-verdict-{label}-<attempt>`, `verdict/verdict.json`, `failing`) names each.",
            "",
        ]
    return [*lines, *effects]


def body(
    kind: str, run: str, commit: str, lanes: Sequence[tuple[str, Mapping | None]], sample_seed: str | None = None
) -> str:
    """The issue's body in Markdown."""
    without = {
        entry["group"]
        for _, verdict in lanes
        if verdict is not None and not lane_readers.from_record(verdict["sections"]["register"].get("readers"))
        for entry in verdict.get("failing") or []
    }
    lines = [OPENINGS[kind].format(commit=commit), "", f"The run: {run}", ""]
    # A dispatch's report is written whether or not its lane held (the nightly's and the weekly's open an issue
    # only on a failure), and one in which every lane held has nothing to rerun.
    if not all(verdict is not None and verdict.get("holds") for _, verdict in lanes):
        lines += [
            "## Rerunning what failed",
            "",
            f"Check out the commit the run checked (`git fetch origin && git checkout {commit}`). Each command"
            " below reruns one group alone: every check of one document or control, one configuration of a"
            " document that was observed in pieces, or one package's failing tests, on one worker. The gate"
            " command after it holds that slice to the lane's verdict; a slice's gate also reports the register's"
            " entries on documents it did not run as not run, so read the problems that name your group.",
            "",
        ]
    if sample_seed:
        lines += [
            f"The comparison lanes checked the corpus sample the seed `{sample_seed}` chooses, which turns each"
            " week. To run the week again on the same sample, dispatch the audit with that seed:",
            "",
            "```bash",
            f"gh workflow run proof-audit.yml -f nightly=false -f weekly=true -f sample_seed={sample_seed}",
            "```",
            "",
        ]
    for label, verdict in lanes:
        lines += _lane(label, verdict, without, run)
    return "\n".join(lines).rstrip() + "\n"


def _load(path: Path) -> Mapping | None:
    """A lane's verdict, with what it found of the committed effects (``effects.json`` beside it) where it held
    them; None where the lane left no verdict."""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict) or "sections" not in value:
        return None
    try:
        effects = json.loads(Path(path).with_name("effects.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return value
    return {**value, "effects": effects} if isinstance(effects, dict) else value


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m proof.lane.report", description=__doc__.splitlines()[0])
    parser.add_argument("--kind", choices=sorted(OPENINGS), required=True)
    parser.add_argument("--run", required=True, help="the run's URL")
    parser.add_argument("--commit", required=True, help="the commit the run checked")
    parser.add_argument("--lane", action="append", default=[], metavar="LABEL=VERDICT", help="a lane's verdict")
    parser.add_argument("--sample-seed", help="the seed that chose the comparison lanes' sample (the weekly's)")
    parser.add_argument("--out", type=Path, help="where to write the body (standard output by default)")
    arguments = parser.parse_args(argv)
    lanes = []
    for named in arguments.lane:
        label, equals, path = named.partition("=")
        if not equals or not label:
            print(f"--lane takes LABEL=VERDICT.json; got {named!r}.", file=sys.stderr)
            return 2
        lanes.append((label, _load(Path(path))))
    text = body(arguments.kind, arguments.run, arguments.commit, lanes, arguments.sample_seed)
    if arguments.out is None:
        sys.stdout.write(text)
    else:
        arguments.out.parent.mkdir(parents=True, exist_ok=True)
        arguments.out.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
