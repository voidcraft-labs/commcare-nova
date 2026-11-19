"""The apps Nova reads as made in CommCare HQ are HQ's own, and every variant over them reads as its row says.

Each base of ``proof/matrix/registry.py::BASES`` is authored in a check of
its own (``proof.matrix.author.authored``): HQ's own views, models and form
builder make it, and what the lane retains of it is written to
``$PROOF_OUT/hq-apps/<base>/`` (``proof.matrix.retain``). Then each row of
``variants.json`` over it is made in a fork of the base's state and read by
the reader bundle. Three tests read that one authoring:

- ``test_the_hq_apps_nova_reads_are_hqs_own``: the committed
  ``proof/hq-apps/<base>/`` is what HQ made, byte for byte. Fails on a
  retained app or answer a person edited, or one a pin moved unseen.
- ``test_each_variant_reads_as_its_row_says``: a refusing row reads as an
  account of exactly its findings, a holding row reads and holds its
  fragments, a row whose value HQ never serves is held to that on every run,
  and each use the lane's Python check decides under the row's own entries
  (``parity.row_uses``) is joined to the reader's claim at the same place;
  the rows it checked are counted and the rest named. Fails on a refusal with
  another code, standing or place, a held fragment missing, a variant that
  reads when it must not, and a value HQ cannot hold counted as one an app
  can carry.
- ``test_a_base_exhibits_what_it_names``: every entry a base's row names is
  counted by its reading's claim log. Fails on a builder that quietly stops
  authoring a shape at a pin.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from proof.matrix import registry
from proof.matrix.registry import BASES, HQ_APPS

# The base whose A starts from Nova's own publish of a corpus document, which a change to that capture changes.
FROM_NOVAS_PUBLISH = {"hq-nova-then-builder": "targeted-save-to-case-shapes"}


def _joined(items):
    items = list(items)
    if len(items) < 2:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _run_output() -> str:
    """The run's output directory, which ``python3 -m proof.matrix.adopt`` is handed: ``$PROOF_OUT``'s run where it
    is one block's output (``<output>/blocks/<block>``)."""
    out = Path(os.environ.get("PROOF_OUT", ".proof/out"))
    return str(out.parent.parent) if out.parent.name == "blocks" else str(out)


def retained_message(base_id, missing, stale, extra, out, output):
    """A retained base that is not what HQ holds and answers at its pin, and how to adopt what HQ made."""
    clauses = []
    if missing:
        clauses.append(f"it lacks {_joined(missing)}")
    if stale:
        clauses.append(f"{_joined(stale)} changed")
    if extra:
        clauses.append(f"it holds {_joined(extra)}, which HQ did not make")
    message = (
        f"proof/hq-apps/{base_id}/ is not what CommCare HQ holds and answers at its pin: {_joined(clauses)}. What HQ"
        f" made is under {out}. Copy it into proof/hq-apps/{base_id}/ (python3 -m proof.matrix.adopt {output}, with"
        " every other output of a sharded run) and read what changed."
    )
    if base_id in FROM_NOVAS_PUBLISH:
        message += (
            f" This base starts from Nova's own publish of {FROM_NOVAS_PUBLISH[base_id]}, so a change to that"
            " document's capture changes it too."
        )
    return message


def place_line(place):
    """A finding's place as one line, the parts ``lib/publish/hqFindingCopy.ts`` names it by."""
    kind = place.get("kind")
    if kind == "question":
        return f"{place['menuName']} > {place['formName']} > {place['path']}"
    if kind == "form":
        return f"{place['menuName']} > {place['name']}"
    if kind in ("menu", "case-list", "case-detail", "search"):
        return f"{place['name']} ({kind})"
    if kind == "lookup-table":
        return f"the lookup table {place['tag']}"
    if kind == "media":
        return f"the file {place['path']}"
    return kind


def refused_message(variant, refusal, got):
    """A variant whose refusal is not the one its row names."""
    return (
        f"The variant {variant.id} should be refused at {place_line(refusal.place)} under {refusal.entry}"
        f" ({refusal.standing}), and Nova's reader answered {got}. Look at the one change the variant makes (its row"
        " in proof/matrix/variants.json) and at the reader's claim for that key."
    )


def unserved_message(variant, why):
    """A variant whose value HQ does not serve, and the exemption that records it."""
    return (
        f"CommCare HQ doesn't serve the value the variant {variant.id} sets: {why}. An app's source never carries it,"
        f" so Nova never reads it. Record that in the row (hqNeverServes) and exempt {variant.entry} as"
        " hq-never-serves-the-value. If the change itself is wrong, look at the row's change in"
        " proof/matrix/variants.json."
    )


def served_message(variant, was):
    """An exempted variant whose value HQ serves after all."""
    return (
        f"CommCare HQ now serves the value the variant {variant.id} sets, where it used to {was}. So {variant.entry}"
        " can sit in an app's source after all. Take it out of proof/matrix/exemptions.json, and give the row the"
        " standing and the place the reader should answer."
    )


def _got(answer):
    from proof.matrix.retain import finding_line

    if answer.get("kind") == "read":
        return "that it reads"
    findings = answer.get("findings") or []
    return "; ".join(finding_line(finding) for finding in findings) or f"{answer.get('kind')} with no finding"


def _finding_key(code, standing, place):
    return (code, standing, json.dumps(place, sort_keys=True))


@pytest.fixture(scope="module", params=BASES, ids=[base.id for base in BASES])
def authored_base(request, hq, core_runner, editor_driver, documents):
    """One base authored, retained and its variants made and read (``proof.matrix.author.authored``)."""
    from proof.matrix.author import authored

    base = request.param
    variants = [variant for variant in registry.load_variants() if variant.base == base.id]
    return base, authored(base, documents=documents, driver=editor_driver, core_runner=core_runner, variants=variants)


@pytest.mark.under_determinism
def test_the_hq_apps_nova_reads_are_hqs_own(authored_base):
    base, made = authored_base
    retained = made.retained
    missing, stale, extra = retained.differences(HQ_APPS / base.id)
    assert not (missing or stale or extra), retained_message(
        base.id, missing, stale, extra, retained.out, _run_output()
    )


def _hold_variant(outcome):
    """What is wrong of one variant's outcome against its row (a refusal other than its row's, a value HQ does not
    serve, or an exemption that ended), or None."""
    variant = outcome.variant
    never = variant.hq_never_serves
    if never is not None and "raised" in never:
        if outcome.raised == never["raised"]:
            return None
        if outcome.raised is None:
            return served_message(variant, f"refuse it ({never['raised']})")
        return unserved_message(variant, f"its import refused it ({outcome.raised})")
    if outcome.raised is not None:
        return unserved_message(variant, f"its import refused it ({outcome.raised})")
    if never is not None:
        pointer = never["notServedAt"]
        if pointer in outcome.unserved:
            return None
        return served_message(variant, f"serve something else at {pointer}")
    answer = outcome.answer
    if variant.refusing:
        expected = sorted(
            _finding_key(refusal.entry, refusal.standing, refusal.place) for refusal in variant.refusals()
        )
        found = sorted(
            _finding_key(finding.get("code"), finding.get("standing"), finding.get("place"))
            for finding in answer.get("findings") or []
        )
        if answer.get("kind") == "account" and found == expected:
            return None
        if outcome.unserved:
            return unserved_message(variant, f"its source read holds something else at {outcome.unserved[0]}")
        return refused_message(variant, variant.refusals()[0], _got(answer))
    if answer.get("kind") != "read":
        if outcome.unserved:
            return unserved_message(variant, f"its source read holds something else at {outcome.unserved[0]}")
        return (
            f"The variant {variant.id} should read, holding {variant.entry}, and Nova's reader answered"
            f" {_got(answer)}. Look at the one change the variant makes (its row in proof/matrix/variants.json) and at"
            " the reader's claim for that key."
        )
    from proof.matrix.retain import claimed

    if variant.entry not in claimed(answer):
        if outcome.unserved:
            # HQ's wrap drops a falsy value of a property declared exclude_if_none (jsonobject's
            # JsonProperty.exclude), so a row exhibiting an entry by such a value reads HQ's default instead.
            return unserved_message(variant, f"its source read holds something else at {outcome.unserved[0]}")
        return (
            f"The variant {variant.id} reads, and its claim log counts no claim under {variant.entry}, which the row"
            " says it exhibits. Look at the row's change and at the reader's claim for that key."
        )
    held = {(hold["key"], hold["pointer"]): hold["found"] for hold in answer.get("held") or []}
    wrong = [
        f"{hold['pointer']} of {hold['key']} (it holds {held.get((hold['key'], hold['pointer']))!r})"
        for hold in outcome.holds
        if held.get((hold["key"], hold["pointer"])) != hold["value"]
    ]
    if wrong:
        if outcome.unserved:
            return unserved_message(variant, f"its source read holds something else at {outcome.unserved[0]}")
        return (
            f"The variant {variant.id} reads, and the document does not hold what its row says at {_joined(wrong)}."
            " Look at the row's holds and at the reader's claim for that key."
        )
    return None


def row_entries(variant):
    """A row's own entries: its entry, and each composed finding's (its second's, then each of its also's)."""
    return (variant.entry, *(one["entry"] for one in variant.composed()))


def python_parity(outcomes):
    """The lane's manifest check held to each variant's claim log over the uses it decides under the row's own
    entries (``parity.variant_differences``): the rows it checked, the rows it decides nothing of (raised, unread,
    or no such use), and the differences, each named by its variant."""
    from proof.checks import parity

    checked, unchecked, differences = [], [], []
    for outcome in outcomes:
        if outcome.raised is not None or outcome.answer is None:
            unchecked.append(outcome.variant.id)
            continue
        variant_source = json.loads(outcome.answers["source"].body)
        uses, found = parity.variant_differences(
            outcome.base_source,
            variant_source,
            outcome.answer.get("claims") or "",
            row_entries(outcome.variant),
            document=outcome.variant.id,
        )
        (checked if uses else unchecked).append(outcome.variant.id)
        differences.extend(found)
    return sorted(checked), sorted(unchecked), differences


@pytest.mark.under_determinism
def test_each_variant_reads_as_its_row_says(authored_base):
    base, made = authored_base
    wrong = [message for outcome in made.variants if (message := _hold_variant(outcome)) is not None]
    assert not wrong, "\n".join(wrong)

    from proof.checks import parity

    checked, unchecked, differences = python_parity(made.variants)
    out = Path(os.environ.get("PROOF_OUT", ".proof/out")) / "matrix" / base.id
    out.mkdir(parents=True, exist_ok=True)
    shown = {"checked": len(checked), "checkedByPython": checked, "uncheckedByPython": unchecked}
    (out / "unchecked-by-python.json").write_text(json.dumps(shown, indent="\t") + "\n", encoding="utf-8")
    print(f"{base.id}: the lane's manifest check judged {len(checked)} variants; it decides nothing of {unchecked}")
    assert not differences, "\n".join(
        parity.disagreement(difference.document, difference) for difference in differences
    )


@pytest.mark.under_determinism
def test_a_base_exhibits_what_it_names(authored_base):
    from proof.matrix.retain import claimed

    base, made = authored_base
    counted = set(claimed(made.retained.reading))
    missing = sorted(set(base.exhibits) - counted)
    assert not missing, (
        f"The base {base.id} names {_joined(missing)} among what it exhibits, and Nova's reading of it counts no claim"
        f" under {'it' if len(missing) == 1 else 'them'}. Look at what proof/matrix/bases/ authors for the shape, and"
        " at whether HQ at its pin still makes it."
    )
