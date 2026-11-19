"""Corpus check eligibility shared by collection, queue planning and aggregate audits.

A migration witness compares a retained pre-migration export with the current
republish. Its decided behavior changes are not round-trip or gate effects.
An app made in CommCare HQ (``hq-authored``) runs every check but sensitivity,
whose flips rebuild an A that is no Nova export; parity, the stored-app
comparison and the first-publish judge run on that source alone.
This module is standard-library only, including on the queue's hosted runner.
"""

WITNESS_UNRUN = frozenset({"proof2", "proof3", "proof5", "sensitivity", "parity", "source", "changes"})
HQ_AUTHORED_UNRUN = frozenset({"sensitivity"})
HQ_AUTHORED_ONLY = frozenset({"parity", "source", "changes"})


def migration_witness(source):
    return source.startswith("targeted-migration:")


def hq_authored(source):
    return source.startswith("hq-authored:")


def eligible(check, source):
    if migration_witness(source):
        return check not in WITNESS_UNRUN
    if hq_authored(source):
        return check not in HQ_AUTHORED_UNRUN
    return check not in HQ_AUTHORED_ONLY


def form_xml_unjudged(source):
    """Whether proof 2 leaves each form's built XML (``modules-<m>/forms-<f>.xml``, artifact ``form:<m>.<f>``) out on
    a document of ``source``: on an app made in HQ a form's bytes are Nova's own spelling of the form HQ's form
    builder wrote, which proof 3 and intent judge; every other file HQ builds from the two stored apps compares."""
    return hq_authored(source)


def documents(check, entries):
    return frozenset(entry["id"] for entry in entries if eligible(check, entry.get("source", "")))
