"""Configuration sensitivity: what HQ's build of a document changes when one gate it read is flipped.

For each configuration a corpus document is exported under, A's plain
build and one build per gate it read, flipped, are observed in the
document's unit (``proof.observe.sensitivity``, recorded in the ``a`` part):
each flag HQ read, and each project-space setting it read (CommTrack, sync
cases on form entry, the flat location fixture). A gate HQ did not read
cannot change what it built, so it is not flipped. Which flips are built
and the gates' names are the observation's (``flip_plan``, ``flag_gate``),
named here for the judges; this module judges the record.

A flip is named by its gate entry's id (``toggle/<SYMBOL>``,
``project-space-setting/Domain.commtrack_enabled``,
``project-space-setting/CaseSearchConfig.sync_cases_on_form_entry``,
``project-space-setting/LocationFixtureConfiguration.sync_flat_fixture``),
and what it changes is every difference between the flipped build and the
plain one, as the other checks compare builds
(``proof.checks.compare.build_files`` for every file, the bar's paths for
HQ's verdicts): a difference of the check ``sensitivity`` whose artifact is
the built artifact qualified by the gate,
``suite.xml@toggle/USH_EMPTY_CASE_LIST_TEXT``, and whose kind says the
direction (a file the flipped build adds is ``added``, a ``validate_app``
error it no longer reports is ``removed``).

Every difference must be named in the flipped gate's effects
(``lib/commcare/surface/entries/gates.json``, each an artifact glob and a
structural path, the register's vocabulary; ``named_by``), or fall in a
register class. The register holds every difference one of its entries
names before effects are asked, so a defect whose harm is also what a gate
changes (defect 20: sync on form entry adds a claim with no condition to a
searching module's entry) is held to its entry while the defect lasts, and
the entry is strict as every entry is. A flip to a configuration Nova's
publish refuses (decision 19: it lacks a flag Nova's verdict requires, or
case search where Nova requires it) is still built, because a gate's effects
are what HQ's build changes when the gate flips, wherever that is; its
differences are held to the gate's effects alone, never to the register,
since a symptom there cannot reach anyone.

``python -m proof.checks.sensitivity effects <output>/blocks/*`` reads the
evidence the check wrote in every block of a run (``$PROOF_OUT/checks/sensitivity/``,
where a group's ``PROOF_OUT`` is its block's directory, ``<output>/blocks/<id>``)
and writes each gate entry's effects: every class any flip of that gate
showed on a corpus document, sorted, data positions generalized to ``*``
(``effect_artifact``), and the gates file formatted as Biome formats it. A
gate some run flipped holds its effects, empty where its flips changed
nothing; a gate no run flipped holds none, since no run measured it (a
privilege, a build version, a removed toggle, a setting the build never
read). The evidence must cover every document of the corpus it was run
over, once, or nothing is written: effects written from some blocks would
drop the classes only the others saw, so the run is one that reused no stored
judgment (a group the queue cached runs nowhere and writes no evidence).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from pathlib import Path

from proof.checks.differences import Difference
from proof.observe.sensitivity import COMMTRACK as COMMTRACK
from proof.observe.sensitivity import FLAG_GATE_PREFIX as FLAG_GATE_PREFIX
from proof.observe.sensitivity import FLAT_FIXTURE as FLAT_FIXTURE
from proof.observe.sensitivity import SYNC_ON_FORM_ENTRY as SYNC_ON_FORM_ENTRY
from proof.observe.sensitivity import Flip as Flip
from proof.observe.sensitivity import flag_gate as flag_gate
from proof.observe.sensitivity import flip_plan

PROOF_DIR = Path(__file__).resolve().parents[1]
GATES_JSON = PROOF_DIR.parent / "lib" / "commcare" / "surface" / "entries" / "gates.json"

CHECK = "sensitivity"

# The flips ------------------------------------------------------------------


@dataclass
class FlipResult:
    gate: str
    accepted: bool
    differences: list


@dataclass
class Sensitivity:
    """What one configuration's plain build read, and what each flip changed, as data."""

    document: str
    configuration: str
    refusals: list = field(default_factory=list)
    flags_read: list = field(default_factory=list)
    settings_read: list = field(default_factory=list)
    flips: list = field(default_factory=list)


def accepts(verdict, configuration):
    """Whether Nova's publish would send the document to a project space configured so (decision 19).

    ``verdict`` is the document's ``verdict.json``: its
    ``minimumConfiguration`` names the flags Nova's publish requires and
    whether it requires case search.
    """
    minimum = verdict["minimumConfiguration"]
    if not set(minimum["flags"]) <= set(configuration.flags):
        return False
    return not (minimum["caseSearchEnabled"] and not configuration.case_search_enabled)


def flips(configuration, flags_read, settings_read, verdict):
    """One flip per gate the plain build read (``flip_plan``), each accepted where Nova's publish would send there."""
    return [
        replace(flip, accepted=accepts(verdict, flip.configuration))
        for flip in flip_plan(configuration, flags_read, settings_read)
    ]


def judged(document_id, view, verdict):
    """One configuration's sensitivity, judged from its ``a`` record (``observations.SensitivityView``).

    Each recorded flip's build is compared with the plain build (A's), and
    whether Nova's publish accepts the flip's configuration is read from the
    document's verdict.
    """
    from proof.checks.proof2 import parsed_build

    observed = Sensitivity(document_id, view.configuration, refusals=list(view.refusals))
    if view.plain is None:
        return observed
    observed.flags_read = list(view.flags_read)
    observed.settings_read = list(view.settings_read)
    parsed_plain = parsed_build(view.plain)
    for flip, outcome in view.flips:
        found = flip_differences(document_id, flip.gate, view.plain, parsed_plain, outcome)
        observed.flips.append(FlipResult(flip.gate, accepts(verdict, flip.configuration), found))
    return observed


# What a flip changes --------------------------------------------------------


def _without_state(artifact):
    return artifact.rpartition("@")[0]


def _verdict_differences(document_id, plain, flipped_outcome):
    """HQ's verdicts (``validate_app`` errors, what a build step raised) one build has and the other lacks.

    Core's admission is not one of them: a flipped build is not admitted, and
    the bar holds the plain build's admission (``admission@<state>``).
    """
    from proof.checks.bar import build_differences

    def keyed(outcome):
        counted = {}
        for difference in build_differences(document_id, outcome):
            if difference.artifact.startswith("admission@"):
                continue
            key = (
                _without_state(difference.artifact),
                difference.path,
                difference.at,
                json.dumps(difference.after, sort_keys=True),
            )
            counted.setdefault(key, []).append(difference.after)
        return counted

    before, after = keyed(plain), keyed(flipped_outcome)
    found = []
    for key in sorted(set(before) | set(after)):
        artifact, path, at, _ = key
        surplus = len(after.get(key, [])) - len(before.get(key, []))
        kind, values = ("added", after.get(key, [])) if surplus > 0 else ("removed", before.get(key, []))
        for value in values[: abs(surplus)]:
            found.append(
                Difference(
                    CHECK,
                    document_id,
                    artifact,
                    path,
                    at,
                    kind,
                    None if kind == "added" else value,
                    value if kind == "added" else None,
                )
            )
    return found


def flip_differences(document_id, gate, plain, parsed_plain, flipped_outcome):
    """Every difference between the plain build and one flipped build, each artifact qualified by the gate."""
    from proof.checks.compare.build_files import compare_parsed_builds
    from proof.checks.proof2 import parsed_build

    found = _verdict_differences(document_id, plain, flipped_outcome)
    found += compare_parsed_builds(parsed_plain, parsed_build(flipped_outcome), check=CHECK, document=document_id)
    return [replace(difference, artifact=f"{difference.artifact}@{gate}") for difference in found]


# Effects -------------------------------------------------------------------


def split_artifact(artifact):
    """``(built artifact, gate)`` of a sensitivity difference's artifact."""
    built, separator, gate = artifact.rpartition("@")
    if not separator:
        raise ValueError(f"A sensitivity difference names its flipped gate after '@'; {artifact!r} names none.")
    return built, gate


def effect_artifact(artifact):
    """A built artifact's name with its data positions as ``*``, as an effect names it.

    A form's position (``form:0.1``), an app strings file's language
    (``app_strings:en``), a build profile's id (``<profile id>/suite.xml``)
    and the build profile a build step ran for
    (``create_all_files:<profile id>``) are the app's data, not what the gate
    changes; the rest of a name (``suite.xml``, ``profile.ccpr``,
    ``validate_app``) is HQ's.
    """
    _, separator, base = artifact.rpartition("/")
    prefix = "*/" if separator else ""
    kind, colon, _ = base.partition(":")
    if colon and kind in ("form", "app_strings", "create_all_files"):
        base = f"{kind}:*"
    return f"{prefix}{base}"


def load_effects(path=GATES_JSON):
    """Each gate entry's effects, by gate entry id, as ``(artifact glob, structural path)`` pairs.

    A gate no run flipped holds no effects, so it names nothing.
    """
    entries = json.loads(Path(path).read_text(encoding="utf-8"))
    return {entry["id"]: tuple((e["artifact"], e["path"]) for e in entry.get("effects", ())) for entry in entries}


def named_by(difference, effects):
    """Whether the flipped gate's effects name this difference (its built artifact matches, its path is one)."""
    built, gate = split_artifact(difference.artifact)
    return any(
        difference.path == path and fnmatch.fnmatchcase(built, artifact) for artifact, path in effects.get(gate, ())
    )


@dataclass
class Holding:
    """One document's flips, split as the check holds them."""

    held: list = field(default_factory=list)  # to the register
    explained: list = field(default_factory=list)  # named by their gate's effects, and no entry's
    unexplained_refused: list = field(default_factory=list)  # under a flip Nova refuses, named by no effect


def hold_flips(observed: Iterable[Sensitivity], effects, entries):
    """Split every flip's differences: the register's, the effects', and those a refused flip leaves unnamed."""
    holding = Holding()
    for sensitivity in observed:
        for flip in sensitivity.flips:
            for difference in flip.differences:
                if flip.accepted and any(entry.matches(difference) for entry in entries):
                    holding.held.append(difference)
                elif named_by(difference, effects):
                    holding.explained.append(difference)
                elif flip.accepted:
                    holding.held.append(difference)
                else:
                    holding.unexplained_refused.append(difference)
    return holding


def evidence_of(observed: Iterable[Sensitivity]):
    """Every configuration's reads and flips, with every difference each flip showed, for the lane's evidence."""
    return [
        {
            "configuration": sensitivity.configuration,
            "refused": [refusal.state for refusal in sensitivity.refusals],
            "flagsRead": sensitivity.flags_read,
            "settingsRead": sensitivity.settings_read,
            "flips": [
                {
                    "gate": flip.gate,
                    "accepted": flip.accepted,
                    "differences": [difference.as_json() for difference in flip.differences],
                }
                for flip in sensitivity.flips
            ],
        }
        for sensitivity in observed
    ]


def evidence_records(directories):
    """Each corpus document's sensitivity evidence, by document id, and the documents two runs both wrote."""
    records, twice = {}, []
    for directory in directories:
        for path in sorted(Path(directory, "checks", CHECK).glob("*.json")):
            record = json.loads(path.read_text(encoding="utf-8"))
            if record.get("kind") != "corpus":
                continue
            if record["document"] in records:
                twice.append(record["document"])
            records[record["document"]] = record
    return records, sorted(set(twice))


class CorpusUnknown(ValueError):
    """The corpus the evidence was run over cannot be read, so its completeness cannot be judged."""


def corpus_documents(directories, corpus=None):
    """The ids of the corpus the evidence was run over, and where they were read.

    ``corpus`` (a corpus directory) when given, else ``PROOF_CORPUS``, else
    the corpus each block's run emitted beside its blocks (``<output>/corpus``
    for ``<output>/blocks/<id>``, ``proof.checks.corpus.corpus_root``), all of
    which must list the same documents.
    """
    named = corpus or os.environ.get("PROOF_CORPUS")
    emitted = sorted({Path(d).resolve().parent.parent / "corpus" for d in directories})
    roots = [Path(named)] if named else [root for root in emitted if root.is_dir()]
    if not roots:
        raise CorpusUnknown(
            "No run of those block directories emitted its corpus beside its blocks (<output>/corpus/index.json),"
            " so there is no telling whether the evidence covers it. Name the corpus with --corpus."
        )
    listed = {}
    for root in roots:
        index = root / "index.json"
        try:
            documents = json.loads(index.read_text(encoding="utf-8"))["documents"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise CorpusUnknown(f"{index} is not a corpus index ({{documents: [{{id}}...]}}): {error}") from error
        listed[str(root)] = frozenset(document["id"] for document in documents)
    if len(set(listed.values())) > 1:
        raise CorpusUnknown(
            f"The block directories were run over different corpora ({sorted(listed)} list different documents),"
            " so their evidence is not one run's. Write the effects from the blocks of one run."
        )
    return next(iter(listed.values())), sorted(listed)


def incomplete(records, twice, documents):
    """Why the evidence is not one whole run over ``documents``, as person-readable problems (none when it is)."""

    def named(ids):
        shown = ", ".join(ids[:10])
        return shown + (f" and {len(ids) - 10} more" if len(ids) > 10 else "")

    problems = []
    missing = sorted(documents - set(records))
    if missing:
        problems.append(
            f"No run's evidence holds the sensitivity check on {len(missing)} of the corpus's {len(documents)}"
            f" documents ({named(missing)}), so effects only they would show would be dropped. Name every block"
            " directory of one run that reused no stored judgment (a group the queue cached writes none), and"
            " rerun the shards that did not finish."
        )
    foreign = sorted(set(records) - documents)
    if foreign:
        problems.append(
            f"The evidence holds documents the corpus does not list ({named(foreign)}): a run over another"
            " corpus is mixed in."
        )
    if twice:
        problems.append(f"Two runs both wrote the evidence of {named(twice)}; name each block directory once.")
    return problems


def observed_effects(records):
    """Every effect class the evidence shows, by every gate a run flipped: ``{gate: {(artifact glob, path)}}``.

    A gate whose flips changed nothing maps to an empty set; a gate no run
    flipped is absent.
    """
    found = {}
    for record in records.values():
        for configuration in record["observed"]:
            for flip in configuration["flips"]:
                classes = found.setdefault(flip["gate"], set())
                for difference in flip["differences"]:
                    built, _ = split_artifact(difference["artifact"])
                    classes.add((effect_artifact(built), difference["path"]))
    return found


def with_effects(gates, found):
    """The gate entries with each flipped gate's effects as the runs found them, and none on a gate no run flipped.

    ``effects`` keeps its place in an entry, or follows ``preflight`` where
    the entry had none. Returns the entries and the gates the runs flipped
    that no gate entry names, whose classes have no entry to be written to.
    """
    ids = {entry["id"] for entry in gates}
    written = []
    for entry in gates:
        flipped_here = entry["id"] in found
        effects = [{"artifact": artifact, "path": path} for artifact, path in sorted(found.get(entry["id"], ()))]
        rewritten = {}
        for key, value in entry.items():
            if key != "effects":
                rewritten[key] = value
            elif flipped_here:
                rewritten["effects"] = effects
            if key == "preflight" and "effects" not in entry and flipped_here:
                rewritten["effects"] = effects
        if flipped_here and "effects" not in rewritten:
            rewritten["effects"] = effects
        written.append(rewritten)
    homeless = {gate: sorted(classes) for gate, classes in sorted(found.items()) if gate not in ids and classes}
    return written, homeless


# The gates file, as Biome formats it (tabs, 80 columns, an empty or scalar
# array on one line where it fits, every non-empty object and every array of
# objects expanded): what ``npm run format`` leaves of this file.
LINE_WIDTH = 80
TAB_WIDTH = 2


def _scalar(value):
    return json.dumps(value, ensure_ascii=False)


def _formatted(value, depth, used, suffix):
    inner = "\t" * (depth + 1)
    if isinstance(value, dict):
        if not value:
            return "{}"
        members = list(value.items())
        lines = []
        for index, (key, member) in enumerate(members):
            head = f"{_scalar(key)}: "
            tail = "," if index < len(members) - 1 else ""
            rendered = _formatted(member, depth + 1, (depth + 1) * TAB_WIDTH + len(head), tail)
            lines.append(f"{inner}{head}{rendered}{tail}")
        return "{\n" + "\n".join(lines) + "\n" + "\t" * depth + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        if not any(isinstance(member, (dict, list)) for member in value):
            flat = "[" + ", ".join(_scalar(member) for member in value) + "]"
            if used + len(flat) + len(suffix) <= LINE_WIDTH:
                return flat
        lines = []
        for index, member in enumerate(value):
            tail = "," if index < len(value) - 1 else ""
            lines.append(f"{inner}{_formatted(member, depth + 1, (depth + 1) * TAB_WIDTH, tail)}{tail}")
        return "[\n" + "\n".join(lines) + "\n" + "\t" * depth + "]"
    return _scalar(value)


def format_gates(gates):
    return _formatted(gates, 0, 0, "") + "\n"


def main(argv):
    parser = argparse.ArgumentParser(
        prog="python -m proof.checks.sensitivity",
        description="Write each gate entry's effects from the sensitivity check's evidence.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    effects = commands.add_parser("effects", help="Write each gate entry's effects from the runs' evidence.")
    effects.add_argument(
        "directories", nargs="+", help="Each block's PROOF_OUT (<output>/blocks/*), every block of a run's shards."
    )
    effects.add_argument(
        "--corpus",
        help="The corpus the run read (default: PROOF_CORPUS, else the run's own <output>/corpus beside its blocks).",
    )
    effects.add_argument("--gates", default=str(GATES_JSON), help="The gate entries to read.")
    effects.add_argument("--out", help="Where to write the gate entries (default: --gates, in place).")
    arguments = parser.parse_args(argv)

    records, twice = evidence_records(arguments.directories)
    try:
        documents, read_from = corpus_documents(arguments.directories, arguments.corpus)
    except CorpusUnknown as error:
        print(f"{error} No effects were written.", file=sys.stderr)
        return 1
    problems = incomplete(records, twice, documents)
    if problems:
        print(
            f"The evidence is not one whole run of the sensitivity check over the corpus ({', '.join(read_from)}),"
            " so no effects were written:",
            file=sys.stderr,
        )
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1
    found = observed_effects(records)
    gates = json.loads(Path(arguments.gates).read_text(encoding="utf-8"))
    written, homeless = with_effects(gates, found)
    Path(arguments.out or arguments.gates).write_text(format_gates(written), encoding="utf-8")
    for entry in written:
        if "effects" not in entry:
            continue
        for effect in entry["effects"] or [{"artifact": "-", "path": "(flipped, changed nothing)"}]:
            print(f"{entry['id']}\t{effect['artifact']}\t{effect['path']}")
    for gate, classes in homeless.items():
        print(
            f"The runs flipped {gate}, which no gate entry names, and it changed {len(classes)} classes"
            f" ({classes[:3]}); add its gate entry, then write the effects again.",
            file=sys.stderr,
        )
    return 1 if homeless else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
