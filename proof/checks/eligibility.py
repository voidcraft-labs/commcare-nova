"""Corpus check eligibility shared by collection, queue planning and aggregate audits.

A migration witness compares a retained pre-migration export with the current
republish. Its decided behavior changes are not round-trip or gate effects.
This module is standard-library only, including on the queue's hosted runner.
"""

WITNESS_UNRUN = frozenset({"proof2", "proof3", "proof5", "sensitivity"})


def migration_witness(source):
    return source.startswith("targeted-migration:")


def eligible(check, source):
    return check not in WITNESS_UNRUN or not migration_witness(source)


def documents(check, entries):
    return frozenset(entry["id"] for entry in entries if eligible(check, entry.get("source", "")))
