"""Parity: Nova's reader and the lane's manifest check, two classifiers written apart over one manifest, held to
each other on every app made in CommCare HQ, wherever the lane's check decides.

For each configuration of an ``hq-authored`` document:

1. **The lane's uses.** One call of ``manifest_usage.app_json_uses`` over the
   parsed body of HQ's source answer to the unit's ``authored`` read of part
   ``a`` (``proof.checks.observations.api_reads``), as artifact ``app.json``
   (which reads each form's XForm under ``form:<m>.<f>``), with the
   expressions, CSQL and questions it collects read through the readings the
   manifest observation made of the document's ``authored/app.json``, whose
   forms and expressions are the same text (``manifest_usage.read_observed``),
   and each form opened by the entries of the suite HQ built of A under the
   configuration (``manifest_usage.built_suites``), as the manifest check reads
   A, so a session read is decided against what those entries write.
   Each use has its ``(key, artifact, where)`` and its standing
   (``manifest_usage.standing``).
2. **The reader's claims.** One request to the reader bundle in mode
   ``claims`` over the same read (``proof.checks.readerbundle``), which answers
   the claim log ``serializeClaimLog`` writes, one JSON object a line:
   ``artifact``, ``where``, ``key``, ``entry``, ``standing``, the claims a
   first reading's media plan gives at each hand-off joined in.
3. **The join** (``join``), on ``(artifact, where)``: each use the lane decides
   needs some record at that place naming an entry that names the use's key,
   with a standing that projects to the lane's (``PROJECTS``).
4. **The other way**: every record whose ``key`` is not null is a use the lane
   extracted at that ``(artifact, where)`` with that key.

The lane does not decide a use it calls ``undecided``, a ``held`` use of a key a
HELD-NEW entry shares with no value-class reader, a use of a ``parser:`` key,
or a use of standing ``source``; ``undecided`` counts them by key, and the
check's evidence holds the counts.

A place is where a key's value sits: the lane's use of a schema key sits at
the key's own pointer, and so must the reader's record of it. Nothing here
loosens the join: a record that sits elsewhere is ``unclaimed`` at the use and
``unseen`` at the record, and the side that is wrong is corrected
(``proof/checks/fixtures/place-vectors.json`` holds the two vocabularies alike).

Differences are ``Difference(check="parity", artifact="claims@A",
path="/<key>/<what>")``, ``what`` one of ``unclaimed``, ``entry``, ``standing``
and ``unseen``, the place in ``at``; no register entry may name one.

``join``, ``added_uses`` and ``row_uses`` are pure and read no records:
``proof/matrix/test_retained.py`` joins each variant's added uses that its row's
own entries decide to its claim log with them (``variant_differences``). On a
variant no other use is judged, and no record the other way (``unseen``): a
reader that refuses a thing whole claims nothing inside it, so a use beneath
it is ``unclaimed`` and the refusal's record ``unseen`` only because the
thing is refused. On a base, where nothing is refused, ``differences`` judges
every use and every record.
"""

from __future__ import annotations

import functools
import json
from dataclasses import dataclass

from proof.checks import changes, lookup_parity, manifest_usage, observations, proof6, readerbundle
from proof.checks.differences import Difference, pointer_token

CHECK = "parity"
ARTIFACT = "claims@A"
ALLOWING = frozenset({"HELD", "TARGET-OWNED", "INERT"})
HQ_BUILD_REASON = "not-hq-buildable"
UNCLAIMED, ENTRY, STANDING, UNSEEN = "unclaimed", "entry", "standing", "unseen"


@dataclass(frozen=True)
class Decided:
    """One use the lane's check decides: the use, its standing and the entries that standing rests on."""

    use: manifest_usage.Use
    standing: str
    entries: tuple

    @property
    def place(self):
        return (self.use.artifact, self.use.where)


@dataclass(frozen=True)
class Record:
    """One line of the reader's claim log."""

    artifact: str
    where: str
    key: str | None
    entry: str
    standing: str
    # Where the value the claim reads sits, where it is not ``where`` (a key of a map whose claim names the map's
    # schema key, ``ClaimRecord.at``): the place the first-publish judge's inert allowance reads.
    at: str | None = None


@functools.cache
def manifest():
    return manifest_usage.load_manifest()


@functools.cache
def _entries_by_id(held):
    return {entry.id: entry for entries in held.entries.values() for entry in entries}


def records_of(claims) -> list[Record]:
    """The claim log as records: ``claims`` is the text ``serializeClaimLog`` writes, or records already read."""
    if not isinstance(claims, str):
        return [claim if isinstance(claim, Record) else Record(**claim) for claim in claims]
    found = []
    for line in claims.splitlines():
        if line.strip():
            value = json.loads(line)
            found.append(
                Record(
                    value["artifact"],
                    value["where"],
                    value.get("key"),
                    value["entry"],
                    value["standing"],
                    value.get("at"),
                )
            )
    return found


def _new_without_reader(held, key) -> bool:
    """Whether some HELD-NEW entry naming ``key`` has a value class and no reader (``Manifest.readers``)."""
    return any(
        entry.disposition == "HELD-NEW" and entry.value_class is not None and held.readers.get(entry.id) is None
        for entry in held.entries.get(key, ())
    )


def decides(held, use, standing) -> bool:
    """Whether the lane's check decides a use of this standing (the module's docstring)."""
    if use.key.startswith("parser:") or standing in (manifest_usage.UNDECIDED, manifest_usage.SOURCE):
        return False
    if standing == manifest_usage.HELD and _new_without_reader(held, use.key):
        return False
    return True


def decided_uses(found, held=None) -> tuple[list[Decided], dict[str, int]]:
    """Each use of ``found`` (``manifest_usage.Uses``) the lane decides, with its standing, and the count of the
    others by key."""
    held = held or manifest()
    decided, unjudged = [], {}
    for use in found.uses:
        standing, entries = manifest_usage.standing(held, use)
        if decides(held, use, standing):
            decided.append(Decided(use, standing, tuple(entries)))
        else:
            unjudged[use.key] = unjudged.get(use.key, 0) + 1
    return decided, dict(sorted(unjudged.items()))


def source_uses(source: dict, held=None, *, readings=None, case_types=None, entry_suites=()):
    """The uses one app source answer holds (``manifest_usage.app_json_uses`` as artifact ``app.json``), its
    expressions, CSQL and questions read through ``readings`` where given, and each form opened by the entries of
    ``entry_suites`` (``Form.entry_suites``: the suites HQ built of the app, parsed), which the value classes that
    read what an entry writes into the session read, as the manifest check reads them over the same app
    (``manifest_usage.export_uses``). The source is an app HQ made, so its multimedia map names the files HQ holds
    for it (``App.authored``)."""
    held = held or manifest()
    found = manifest_usage.Uses()
    manifest_usage.app_json_uses(source, held, "app.json", found, authored=True)
    for exported in found.documents:
        if hasattr(exported, "case_types"):
            exported.case_types = case_types
        if isinstance(exported, manifest_usage.Form):
            exported.entry_suites = tuple(entry_suites)
    if readings is not None:
        manifest_usage.read_observed(found, held, readings)
    else:
        found.expressions, found.csql, found.questions = [], [], []
    return found


def added_uses(base_source: dict, variant_source: dict) -> list[Decided]:
    """The uses the lane decides in a variant's source answer that it does not decide alike in its base's: each use
    whose key, place, standing and entries the base's source holds none of."""
    held = manifest()
    base, _ = decided_uses(source_uses(base_source, held), held)
    variant, _ = decided_uses(source_uses(variant_source, held), held)
    seen = {_identity(one) for one in base}
    return [one for one in variant if _identity(one) not in seen]


def left_to_the_bar(held, entry_id, key) -> bool:
    """Whether the lane's standing of a use of ``key`` leaves the class of the entry ``entry_id`` to the bar: a
    REFUSED entry naming the key, refused only because HQ's build refuses its state, beside an entry naming the key
    that is not such an entry (``manifest_usage.standing``, which reads no such class there), so the lane's check
    neither takes a use into that class nor rules one out of it."""
    entry = _entries_by_id(held).get(entry_id)
    naming = held.entries.get(key, ())

    def bar(one):
        return one.disposition == "REFUSED" and one.refused_by_hq_build()

    return entry is not None and entry in naming and bar(entry) and not all(bar(one) for one in naming)


def row_uses(uses, claims, entries, held=None) -> list[Decided]:
    """The uses a variant's row is judged by, of a variant's added uses (``added_uses``): each the lane decides under
    one of the row's own entries (``entries``: its entry, its second's and each of its also's), its standing resting
    on one of them, and each decided use at whose place the claim log names one of them for the use's key, so a use
    the lane holds where the reader refuses the row's class is judged too, but for a record of an entry whose class
    the lane leaves to the bar there (``left_to_the_bar``): the lane's check never read that class, so its standing
    is no verdict on it, and the row's own finding holds it. No other use of a variant is judged: a reader that
    refuses a thing whole claims nothing inside it, so a structural use beneath that thing has no record of its own
    at its place, and the refusal's record stands where the lane decides nothing under the row."""
    held = held or manifest()
    entries = frozenset(entries)
    named = {
        (record.artifact, record.where, record.key)
        for record in records_of(claims)
        if record.entry in entries and not left_to_the_bar(held, record.entry, record.key)
    }
    return [
        decided
        for decided in uses
        if any(entry.id in entries for entry in decided.entries)
        or (decided.use.artifact, decided.use.where, decided.use.key) in named
    ]


def variant_differences(base_source: dict, variant_source: dict, claims, entries, *, document: str = ""):
    """A variant's parity, as the lane judges one (the row's own uses, ``row_uses``, joined to its claim log): the
    uses judged, and the differences. A row whose judged uses are none is one the lane's check does not decide."""
    uses = row_uses(added_uses(base_source, variant_source), claims, entries)
    if {lookup_parity.OMITTED_INSTANCE, lookup_parity.INTERPOLATED_COLUMN}.intersection(entries):
        by_id = _entries_by_id(manifest())
        for key, where, entry in lookup_parity.changed_form_condition_refusals(base_source, variant_source):
            uses.append(Decided(manifest_usage.Use(key, "app.json", where), manifest_usage.REFUSED, (by_id[entry],)))
    return uses, join(uses, claims, document=document)


def _identity(decided: Decided):
    return (
        decided.use.key,
        decided.use.artifact,
        decided.use.where,
        decided.standing,
        tuple(entry.id for entry in decided.entries),
    )


def _projects(decided: Decided, record: Record, held) -> tuple[bool, bool]:
    """Whether the reader's record projects to the lane's standing, and whether its entry is one the lane's standing
    allows: ``(standing agrees, entry agrees)``."""
    resting = {entry.id for entry in decided.entries}
    entry = _entries_by_id(held).get(record.entry)
    standing = decided.standing
    if standing == manifest_usage.REFUSED:
        return record.standing in ("never", "fix-in-hq"), record.entry in resting
    if standing == manifest_usage.BAR:
        refused = (
            entry is not None
            and entry.disposition == "REFUSED"
            and (HQ_BUILD_REASON in entry.reasons or entry.refused_by_hq_build())
        )
        return record.standing == "fix-in-hq", refused
    if standing == manifest_usage.HELD_NEW:
        return record.standing == "not-yet", record.entry in resting
    if standing == manifest_usage.HELD:
        return record.standing in ("held", "kept", "inert"), entry is not None and entry.disposition in ALLOWING
    # UNNAMED and UNHELD: no entry the reader may claim it under names the key.
    return False, False


def _difference(document, decided_or_record, what, before, after):
    key, artifact, where = decided_or_record
    path = f"/{pointer_token(key)}/{what}"
    return Difference(CHECK, document, ARTIFACT, path, f"{path}@{artifact}{where}", "changed", before, after)


def _record_json(record: Record):
    return {
        "artifact": record.artifact,
        "where": record.where,
        "key": record.key,
        "entry": record.entry,
        "standing": record.standing,
    }


def _lane_json(decided: Decided):
    return {"standing": decided.standing, "entries": [entry.id for entry in decided.entries]}


def join(uses, claims, *, document: str = "", held=None) -> list[Difference]:
    """The lane's decided uses (``Decided``) joined to the reader's claim log on ``(artifact, where)``: one
    difference a use whose place holds no record naming an entry of its key (``unclaimed``), whose records name
    only entries outside what its standing allows (``entry``), or whose records' standings do not project to it
    (``standing``). ``held`` is the manifest the uses were decided over (the lane's, by default)."""
    held = held or manifest()
    at_place = {}
    for record in records_of(claims):
        at_place.setdefault((record.artifact, record.where), []).append(record)
    found = []
    for decided in uses:
        use = decided.use
        naming_ids = {entry.id for entry in held.entries.get(use.key, ())}
        records = at_place.get(decided.place, [])
        naming = [record for record in records if record.entry in naming_ids]
        place = (use.key, use.artifact, use.where)
        lane = _lane_json(decided)
        if decided.standing in (manifest_usage.UNNAMED, manifest_usage.UNHELD):
            # No entry the reader may claim the use under names its key: the reading's own account says
            # ``unrecognized`` there, which the claim log does not carry. A record of the key there is the drift.
            wrong = [record for record in records if record.key == use.key]
            if wrong:
                found.append(_difference(document, place, ENTRY, lane, [_record_json(r) for r in wrong]))
            continue
        if not naming:
            mismatched = [record for record in records if record.key == use.key]
            what = ENTRY if mismatched else UNCLAIMED
            found.append(_difference(document, place, what, lane, [_record_json(r) for r in mismatched]))
            continue
        verdicts = [(record, *_projects(decided, record, held)) for record in naming]
        if any(standing and entry for _, standing, entry in verdicts):
            continue
        what = ENTRY if any(standing for _, standing, _ in verdicts) else STANDING
        found.append(_difference(document, place, what, lane, [_record_json(r) for r in naming]))
    return found


def claim_places(claims) -> changes.ClaimPlaces:
    """Each place of the app's own JSON a record of the claim log reads, those under an entry of standing inert apart
    from the rest: what the first-publish judge's inert allowance reads (``proof.checks.changes.inert_holds``). A
    record's place is the value it reads (``at``), where that is not where its key's value sits: a key of a
    language's strings is claimed under ``schema:Application.translations`` and recorded at ``/translations``, the
    map's own key, where the join reads it, while the key itself is the value a first publish keeps or drops."""
    records = [record for record in records_of(claims) if record.artifact == "app.json"]
    return changes.ClaimPlaces(
        inert=frozenset(record.at or record.where for record in records if record.standing == "inert"),
        other=frozenset(record.at or record.where for record in records if record.standing != "inert"),
    )


def unseen(found_uses, claims, *, document: str = "") -> list[Difference]:
    """Each record of the claim log whose key is not null at a place where the lane extracted no use of that key."""
    extracted = {(use.key, use.artifact, use.where) for use in found_uses}
    differences = []
    for record in records_of(claims):
        if record.key is None or (record.key, record.artifact, record.where) in extracted:
            continue
        differences.append(
            _difference(document, (record.key, record.artifact, record.where), UNSEEN, None, _record_json(record))
        )
    return differences


def _readings(document, records):
    observed = manifest_usage.observed_exports(document, records)
    return manifest_usage.Readings.of(records.blobs.get_json(observed["readings"]))


def _authored_reads(document, records, name):
    reads = observations.api_reads(records, name, "a", "authored")
    if reads is None and (records.configurations[name].a or {}).get("state"):
        raise observations.RecordIncomplete(
            f"{document.id}'s {name}/a record holds no authored read (apiReads.authored), which parity reads"
            " (proof/observe/unit.py::_Unit.api_reads)."
        )
    return reads


# The claim logs of the document whose checks run now: parity and the first-publish judge read the same logs, and
# a document's checks run together (``sharding.order_by_group``), so the bundle reads them once.
_CLAIMS: dict = {}


def claims_logs(document, records) -> dict:
    """The reader's claim log over each configuration's ``authored`` read, by configuration: one bundle run for the
    document, mode ``claims``, kept while the document's checks run."""
    owner = (document.kind, document.id)
    if _CLAIMS.get("owner") == owner:
        return _CLAIMS["logs"]
    _CLAIMS.clear()
    requests, names = [], []
    for name in sorted(document.exports):
        reads = _authored_reads(document, records, name)
        if reads is None:
            continue
        lane_input, _ = proof6.first_read_input(document, reads, claims="full")
        requests.append({"id": f"{document.id}@{name}@claims", "mode": "claims", "input": lane_input})
        names.append(name)
    logs = {}
    if requests:
        answers = readerbundle.run_reader(requests, log_name=f"claims-{document.id}")
        logs = {name: answer.get("claims") or "" for name, answer in zip(names, answers, strict=True)}
    _CLAIMS.update(owner=owner, logs=logs)
    return logs


def claim_places_of(document, records) -> changes.ClaimPlaces:
    """The places of every configuration's claim log together (``claim_places``)."""
    found = [claim_places(log) for log in claims_logs(document, records).values()]
    return changes.ClaimPlaces(
        inert=frozenset().union(*(places.inert for places in found)),
        other=frozenset().union(*(places.other for places in found)),
    )


def _lane_uses(document, records, name, readings, reads):
    if reads is None:
        return None
    source = observations.answer_json(reads["source"])
    if not isinstance(source, dict):
        raise observations.RecordIncomplete(
            f"{document.id}'s authored read of {name} holds no app source HQ served as JSON, which parity reads."
        )
    # The suite HQ built of A under this configuration, as the manifest check reads it beside A's forms
    # (``manifest_usage.export_uses``): a display condition's, a form link's and a form's read of the session's
    # ``data/<id>`` is decided against what the entries there write (``datum_not_supplied``), never left undecided.
    built = manifest_usage.built_suites(document, records, [(name, "a")])
    return source_uses(source, readings=readings, case_types=document.case_types(), entry_suites=built)


def differences(document, records, *, claims=None) -> list[Difference]:
    """Parity's differences on one document made in HQ (the module's docstring). ``claims`` is the claim log by
    configuration where a caller already read it (``claims_logs``)."""
    claims = claims_logs(document, records) if claims is None else claims
    readings = _readings(document, records)
    found = []
    for name in sorted(claims):
        reads = _authored_reads(document, records, name)
        uses = _lane_uses(document, records, name, readings, reads)
        if uses is None:
            continue
        decided, _ = decided_uses(uses)
        found += join(decided, claims[name], document=document.id)
        found += unseen(uses.uses, claims[name], document=document.id)
        found += lookup_parity.differences(document.id, manifest(), uses.lookup_tags, reads, records_of(claims[name]))
    return found


def undecided(document, records) -> dict[str, int]:
    """The uses the lane's check does not decide on the document's A, counted by key, over every configuration."""
    readings = _readings(document, records)
    counts = {}
    for name in sorted(document.exports):
        reads = _authored_reads(document, records, name)
        uses = _lane_uses(document, records, name, readings, reads)
        if uses is None:
            continue
        _, unjudged = decided_uses(uses)
        for key, count in unjudged.items():
            counts[key] = counts.get(key, 0) + count
    return dict(sorted(counts.items()))


def disagreement(document_id, difference: Difference) -> str:
    """The message for one parity difference: the key, where it sits, both standings, and where to look."""
    key = difference.path.split("/")[1].replace("~1", "/").replace("~0", "~")
    _, _, place = difference.at.partition("@")
    artifact, slash, where = place.partition("/")
    lane = difference.before or {}
    claimed = difference.after
    records = claimed if isinstance(claimed, list) else [claimed] if isinstance(claimed, dict) else []
    entry = ", ".join(record["entry"] for record in records) or "no entry"
    reader_standing = ", ".join(record["standing"] for record in records) or "no claim"
    lane_standing = lane.get("standing", "no use") if isinstance(lane, dict) else "no use"
    return (
        f"Nova's reader and the lane's manifest check disagree about {key} at {slash}{where} in {artifact} of"
        f" {document_id}: the reader claimed it under {entry} ({reader_standing}), and the lane reads it as"
        f" {lane_standing}. One of the two is wrong about this value. Look at the entry's row in"
        " lib/commcare/surface/entries/ and at the value itself."
    )
